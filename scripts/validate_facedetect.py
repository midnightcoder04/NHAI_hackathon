#!/usr/bin/env python3
"""Validate BlazeFace face *detection* accuracy on LFW — f16 vs int8.

A detector has no class label, so "accuracy" here is measured two ways, both on
the already-local LFW funneled images (each LFW image is one near-frontal face,
so "did we return a box?" is a clean proxy):

  1. DETECTION RATE  — fraction of single-face images where the model returns a
     best detection >= threshold, plus the confidence / box-area distributions.
     Run for both the shipped f16 model and the candidate int8 model.

  2. int8 -> f16 PARITY — on images where BOTH detect, how close int8 stays to
     the f16 reference: median box IoU, keypoint error (in 128px input space),
     and score agreement. f16 is the de-facto reference (it is the only BlazeFace
     bundled in mobile/assets/models), so int8 "accuracy" is really how little
     the quantization moved the box.

Decode / anchors / NMS-free best-pick mirror scripts/test_blazeface_f16.py and
mobile/src/ml/FaceDetector.ts (selectBestDetection = highest conf above floor).

KEY int8 GOTCHA (confirmed by inspecting the .tflite):
  f16  : input float32 [-1,1];  2 merged float outputs
         classificators[1,896,1], regressors[1,896,16].
  int8 : input uint8 (scale 0.00784, zp 127);  4 split uint8 outputs that must be
         dequantized and concatenated in anchor order (16x16 grid then 8x8 grid):
           scores  = [Identity(512,1),  Identity_1(384,1)]   -> 896
           boxes   = [Identity_2(512,16), Identity_3(384,16)] -> 896
  Note: the 8x8 score tensor is brutally quantized (scale ~115 in logit space),
  which the per-grid breakdown below makes visible.

Usage:
  python scripts/validate_facedetect.py                  # test subset, thr 0.6
  python scripts/validate_facedetect.py --limit 300      # first 300 images (fast)
  python scripts/validate_facedetect.py --threshold 0.5  # sweep a different floor
  python scripts/validate_facedetect.py --trace 8        # per-image traces

First run downloads the LFW funneled dataset (~200 MB) to ~/scikit_learn_data.
"""
import argparse
import pathlib
import time

import numpy as np
from PIL import Image
from ai_edge_litert.interpreter import Interpreter
from sklearn.datasets import fetch_lfw_pairs

REPO = pathlib.Path(__file__).resolve().parent.parent
_BUNDLE = REPO / "mobile" / "assets" / "models"
_ROOT = REPO / "models"
# Shipped f16 is bundled; int8 only lives at repo-root models/.
F16_MODEL = (_BUNDLE if (_BUNDLE / "blaze_face_short_range_float16.tflite").exists()
             else _ROOT) / "blaze_face_short_range_float16.tflite"
INT8_MODEL = _ROOT / "blaze_face_short_1x3x128x128_range_int8.tflite"

SIZE = 128  # BlazeFace short-range input is 128x128


def resize_rgb(rgb_uint8, size):
    return np.asarray(Image.fromarray(rgb_uint8).resize((size, size), Image.BILINEAR))


# --------------------------------------------------------------------------- #
# Anchors / decode  (test_blazeface_f16.py)                                   #
# --------------------------------------------------------------------------- #
def gen_anchors():
    a = []
    for n in range(16 * 16):
        r, c = divmod(n, 16)
        a += [((c + 0.5) / 16, (r + 0.5) / 16)] * 2  # 512  (16x16 grid x2)
    b = []
    for n in range(8 * 8):
        r, c = divmod(n, 8)
        b += [((c + 0.5) / 8, (r + 0.5) / 8)] * 6     # 384  (8x8 grid x6)
    return np.array(a, np.float32), np.array(b, np.float32)


_ANCHORS_A, _ANCHORS_B = gen_anchors()
ANCHORS = np.concatenate([_ANCHORS_A, _ANCHORS_B], axis=0)  # 896
N_GRID16 = len(_ANCHORS_A)  # 512 — anchors below this index come from the 16x16 grid


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-np.clip(x, -50, 50)))


def decode(scores, boxes, anchors):
    conf = sigmoid(scores)
    cx = boxes[:, 0] / SIZE + anchors[:, 0]
    cy = boxes[:, 1] / SIZE + anchors[:, 1]
    w = boxes[:, 2] / SIZE
    h = boxes[:, 3] / SIZE
    box = np.stack([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], 1)
    kx = boxes[:, 4::2] / SIZE + anchors[:, 0:1]
    ky = boxes[:, 5::2] / SIZE + anchors[:, 1:2]
    kps = np.stack([kx, ky], 2)
    return conf, box, kps


# --------------------------------------------------------------------------- #
# Detector wrapper — handles BOTH the merged-float (f16) and split-uint8 (int8) #
# output layouts behind one detect(rgb, thr) -> best detection.                #
# --------------------------------------------------------------------------- #
def make_detector(model_path):
    interp = Interpreter(model_path=str(model_path))
    interp.allocate_tensors()
    inp = interp.get_input_details()[0]
    outs = interp.get_output_details()

    iq = inp["quantization_parameters"]
    in_is_int = np.issubdtype(inp["dtype"], np.integer)
    in_scale = float(iq["scales"][0]) if in_is_int and len(iq["scales"]) else 1.0
    in_zp = int(iq["zero_points"][0]) if in_is_int and len(iq["zero_points"]) else 0

    def deq(o):
        raw = interp.get_tensor(o["index"]).astype(np.float32)
        q = o["quantization_parameters"]
        if np.issubdtype(o["dtype"], np.integer) and len(q["scales"]):
            raw = (raw - int(q["zero_points"][0])) * float(q["scales"][0])
        return raw

    # Split outputs into the two score tensors (last dim 1) and two box tensors
    # (last dim 16), each ordered 512-grid (16x16) then 384-grid (8x8).
    score_outs = sorted((o for o in outs if o["shape"][-1] == 1),
                        key=lambda o: -o["shape"][1])
    box_outs = sorted((o for o in outs if o["shape"][-1] == 16),
                      key=lambda o: -o["shape"][1])

    def run(rgb):
        real = resize_rgb(rgb, SIZE).astype(np.float32) / 127.5 - 1.0  # [-1,1] RGB
        if in_is_int:
            x = np.round(real / in_scale + in_zp).clip(0, 255).astype(inp["dtype"])
        else:
            x = real.astype(inp["dtype"])
        interp.set_tensor(inp["index"], x[None])
        interp.invoke()
        scores = np.concatenate([deq(o).reshape(-1) for o in score_outs], 0)
        boxes = np.concatenate([deq(o).reshape(-1, 16) for o in box_outs], 0)
        return scores, boxes

    def detect(rgb, thr):
        """Best (box_xyxy_norm, kps_norm[6,2], conf, grid16_bool) >= thr, or None.

        Mirrors selectBestDetection: greedy NMS always keeps the top-scoring box,
        so the single best = highest-conf box above the floor with a valid area.
        """
        scores, boxes = run(rgb)
        conf, box, kps = decode(scores, boxes, ANCHORS)
        box = np.clip(box, 0.0, 1.0)
        valid = (conf > thr) & (box[:, 2] - box[:, 0] > 1e-3) & (box[:, 3] - box[:, 1] > 1e-3)
        if not valid.any():
            return None
        idx = np.flatnonzero(valid)
        best = idx[int(np.argmax(conf[idx]))]
        return box[best], kps[best], float(conf[best]), bool(best < N_GRID16)

    return detect


# --------------------------------------------------------------------------- #
# Geometry helpers                                                             #
# --------------------------------------------------------------------------- #
def iou_xyxy(a, b):
    xx1, yy1 = max(a[0], b[0]), max(a[1], b[1])
    xx2, yy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, xx2 - xx1) * max(0.0, yy2 - yy1)
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / (ua + 1e-9)


def box_area(b):
    return (b[2] - b[0]) * (b[3] - b[1])


def pct(xs, p):
    return float(np.percentile(xs, p)) if len(xs) else float("nan")


# --------------------------------------------------------------------------- #
def report_rate(name, dets, n_total):
    found = [d for d in dets if d is not None]
    rate = len(found) / n_total if n_total else 0.0
    confs = np.array([d[2] for d in found])
    areas = np.array([box_area(d[0]) for d in found])
    grid16 = sum(1 for d in found if d[3])
    print(f"\n  {name}")
    print(f"    detection rate : {rate*100:6.2f}%  ({len(found)}/{n_total})")
    if len(found):
        print(f"    confidence     : mean {confs.mean():.3f}  "
              f"median {np.median(confs):.3f}  min {confs.min():.3f}")
        print(f"    box area ratio : median {np.median(areas)*100:5.2f}% of frame  "
              f"(p10 {pct(areas,10)*100:.2f}%  p90 {pct(areas,90)*100:.2f}%)")
        print(f"    best-anchor grid: {grid16/len(found)*100:5.1f}% from 16x16 (small-face) "
              f"grid, {100-grid16/len(found)*100:5.1f}% from 8x8 (large-face) grid")
    return rate


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--subset", default="test", choices=["train", "test", "10_folds"])
    ap.add_argument("--resize", type=float, default=1.0)
    ap.add_argument("--limit", type=int, default=0, help="cap #images (0 = all)")
    ap.add_argument("--threshold", type=float, default=0.6)
    ap.add_argument("--trace", type=int, default=0)
    args = ap.parse_args()

    for p in (F16_MODEL, INT8_MODEL):
        if not p.exists():
            raise SystemExit(f"Model not found: {p}")

    print(f"[1/3] Loading fetch_lfw_pairs(subset='{args.subset}', color=True, "
          f"resize={args.resize}) …")
    pairs = fetch_lfw_pairs(subset=args.subset, color=True, resize=args.resize)
    X = pairs.pairs  # (n, 2, H, W, 3) float [0,1]
    imgs = X.reshape(-1, *X.shape[2:])  # flatten both sides of every pair
    imgs = [(im * 255.0).round().clip(0, 255).astype(np.uint8) for im in imgs]
    if args.limit:
        imgs = imgs[:args.limit]
    print(f"      {len(imgs)} single-face images  (each LFW image = one face)")
    print(f"      f16 : {F16_MODEL.relative_to(REPO)}")
    print(f"      int8: {INT8_MODEL.relative_to(REPO)}")

    print(f"[2/3] Detecting (threshold {args.threshold}) …")
    det_f16 = make_detector(F16_MODEL)
    det_int8 = make_detector(INT8_MODEL)

    t = time.time()
    res_f16 = [det_f16(im, args.threshold) for im in imgs]
    res_int8 = [det_int8(im, args.threshold) for im in imgs]
    dt = time.time() - t

    print("\n[3/3] Results")
    r_f16 = report_rate("f16  (shipped)", res_f16, len(imgs))
    r_int8 = report_rate("int8 (candidate)", res_int8, len(imgs))

    # Parity on images where BOTH detect — int8 accuracy = closeness to f16.
    ious, kperr, dscore = [], [], []
    both = 0
    for a, b in zip(res_f16, res_int8):
        if a is None or b is None:
            continue
        both += 1
        ious.append(iou_xyxy(a[0], b[0]))
        # keypoint error reported in 128px input-space pixels
        kperr.append(float(np.linalg.norm((a[1] - b[1]) * SIZE, axis=1).mean()))
        dscore.append(abs(a[2] - b[2]))
    print(f"\n  int8 -> f16 parity   (on {both} images both detected)")
    if both:
        ious = np.array(ious); kperr = np.array(kperr); dscore = np.array(dscore)
        print(f"    box IoU        : median {np.median(ious):.3f}  "
              f"mean {ious.mean():.3f}  p10 {pct(ious,10):.3f}  "
              f"(>=0.5: {np.mean(ious>=0.5)*100:.1f}%  >=0.7: {np.mean(ious>=0.7)*100:.1f}%)")
        print(f"    keypoint error : median {np.median(kperr):.2f}px  "
              f"mean {kperr.mean():.2f}px  (of 128px input)")
        print(f"    |score| diff   : median {np.median(dscore):.3f}  mean {dscore.mean():.3f}")
    only_f16 = sum(1 for a, b in zip(res_f16, res_int8) if a and not b)
    only_int8 = sum(1 for a, b in zip(res_f16, res_int8) if b and not a)
    print(f"    disagreements  : f16-only {only_f16}, int8-only {only_int8}")

    if args.trace:
        print(f"\n  traces (first {args.trace}):")
        print(f"    {'#':>4} {'f16 conf':>9} {'int8 conf':>9} {'IoU':>6} {'kp px':>6}")
        for i, (a, b) in enumerate(zip(res_f16, res_int8)):
            if i >= args.trace:
                break
            ca = f"{a[2]:.3f}" if a else "  --"
            cb = f"{b[2]:.3f}" if b else "  --"
            io = f"{iou_xyxy(a[0], b[0]):.3f}" if a and b else "   --"
            kp = (f"{np.linalg.norm((a[1]-b[1])*SIZE, axis=1).mean():.1f}"
                  if a and b else "  --")
            print(f"    {i:>4} {ca:>9} {cb:>9} {io:>6} {kp:>6}")

    print(f"\n  ({len(imgs)} imgs x2 models in {dt:.1f}s, "
          f"{2*len(imgs)/max(dt,1e-6):.0f} det/s)")
    verdict = "PARITY OK" if (both and np.median(ious) >= 0.7 and
                              abs(r_int8 - r_f16) < 0.05) else "INT8 DEGRADED vs f16"
    print(f"\n  Verdict: {verdict}  "
          f"(f16 rate {r_f16*100:.1f}% / int8 rate {r_int8*100:.1f}%)\n")


if __name__ == "__main__":
    main()
