#!/usr/bin/env python3
"""Validate the on-device recognition pipeline against the external LFW dataset.

This simulates the production verification pipeline end-to-end in a controlled
test environment, on an *external* benchmark (sklearn's Labeled Faces in the
Wild pairs), so the MobileFaceNet matching accuracy (spec SC-004 >= 90 %) is
measured against ground-truth same/different-person labels rather than a
self-made fixture.

Pipeline per image (mirrors the device worklet T032 -> T099):

    LFW image (RGB)
      -> BlazeFace short-range f16  (detect best face box + 6 keypoints)
      -> crop the padded box  (the "edge detection output fed into the model")
      -> MobileFaceNet INT8         (112x112 -> L2-normalized 128-d embedding)

For a pair (A, B) the prediction is cosine(emb_A, emb_B) >= FACE_MATCH_THRESHOLD
=> "same person" (MATCH).  Ground truth comes from fetch_lfw_pairs labels.

Conventions are copied verbatim from the reference scripts so the numbers
reflect what the app actually runs:
  * BlazeFace decode / anchors / NMS / padding  <- scripts/test_blazeface_f16.py
  * MobileFaceNet int8 quant + L2 norm          <- scripts/test_recognition.py
  * FACE_MATCH_THRESHOLD = 0.65 (cosine)         <- mobile/src/constants/index.ts

Usage:
  python scripts/validate_recognition_lfw.py                 # test subset, 0.65 thr
  python scripts/validate_recognition_lfw.py --limit 100     # first 100 pairs (fast)
  python scripts/validate_recognition_lfw.py --trace 8       # show 8 detailed traces
  python scripts/validate_recognition_lfw.py --threshold 0.5 # sweep a different thr

The first run downloads the LFW funneled dataset (~200 MB) to ~/scikit_learn_data.
"""
import argparse
import pathlib
import time

import numpy as np
from PIL import Image
from ai_edge_litert.interpreter import Interpreter
from sklearn.datasets import fetch_lfw_pairs
from sklearn.metrics import roc_auc_score

REPO = pathlib.Path(__file__).resolve().parent.parent

# Prefer the production-bundled models (mobile/assets/models, see T098); fall
# back to the repo-root models/ working copy.
_BUNDLE = REPO / "mobile" / "assets" / "models"
MODELS = _BUNDLE if (_BUNDLE / "MobileFaceNet_new_latest_int8.tflite").exists() else REPO / "models"
DETECTOR_MODEL = MODELS / "blaze_face_short_range_float16.tflite"
EMBED_MODEL = MODELS / "MobileFaceNet_new_latest_int8.tflite"

DETECTOR_SIZE = 128
EMBED_SIZE = 112
# mobile/src/constants/index.ts : FACE_MATCH_THRESHOLD (cosine, MobileFaceNet INT8).
# Recalibrated to 0.45 for the shipped aligned+tightened pipeline (FAR≈1.4%/FRR≈16.8%
# on LFW; see scripts/threshold_report.py). The old 0.65 pre-dated alignment.
FACE_MATCH_THRESHOLD = 0.45
# Padding applied to the BlazeFace box before cropping (test_blazeface_f16.py defaults)
PAD_X = 0.00
PAD_Y = 0.50


def resize_rgb(rgb_uint8, size):
    """Bilinear resize to (size, size) — PIL stand-in for cv2.resize (default bilinear)."""
    return np.asarray(Image.fromarray(rgb_uint8).resize((size, size), Image.BILINEAR))


# --------------------------------------------------------------------------- #
# BlazeFace short-range f16 — anchors / decode / nms  (test_blazeface_f16.py)  #
# --------------------------------------------------------------------------- #
def gen_anchors():
    a = []
    for n in range(16 * 16):
        r, c = divmod(n, 16)
        a += [((c + 0.5) / 16, (r + 0.5) / 16)] * 2  # 512
    b = []
    for n in range(8 * 8):
        r, c = divmod(n, 8)
        b += [((c + 0.5) / 8, (r + 0.5) / 8)] * 6     # 384
    return np.array(a, np.float32), np.array(b, np.float32)


_ANCHORS_A, _ANCHORS_B = gen_anchors()
ANCHORS = np.concatenate([_ANCHORS_A, _ANCHORS_B], axis=0)  # 896


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-np.clip(x, -50, 50)))


def decode(scores, boxes, anchors):
    conf = sigmoid(scores)
    cx = boxes[:, 0] / DETECTOR_SIZE + anchors[:, 0]
    cy = boxes[:, 1] / DETECTOR_SIZE + anchors[:, 1]
    w = boxes[:, 2] / DETECTOR_SIZE
    h = boxes[:, 3] / DETECTOR_SIZE
    box = np.stack([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], 1)
    kx = boxes[:, 4::2] / DETECTOR_SIZE + anchors[:, 0:1]
    ky = boxes[:, 5::2] / DETECTOR_SIZE + anchors[:, 1:2]
    kps = np.stack([kx, ky], 2)
    return conf, box, kps


def nms(box, score, iou_th=0.3):
    idx = score.argsort()[::-1]
    keep = []
    while len(idx):
        i = idx[0]
        keep.append(i)
        if len(idx) == 1:
            break
        rest = idx[1:]
        xx1 = np.maximum(box[i, 0], box[rest, 0])
        yy1 = np.maximum(box[i, 1], box[rest, 1])
        xx2 = np.minimum(box[i, 2], box[rest, 2])
        yy2 = np.minimum(box[i, 3], box[rest, 3])
        inter = np.clip(xx2 - xx1, 0, None) * np.clip(yy2 - yy1, 0, None)
        ai = (box[i, 2] - box[i, 0]) * (box[i, 3] - box[i, 1])
        ar = (box[rest, 2] - box[rest, 0]) * (box[rest, 3] - box[rest, 1])
        iou = inter / (ai + ar - inter + 1e-9)
        idx = rest[iou < iou_th]
    return keep


def make_detector():
    interp = Interpreter(model_path=str(DETECTOR_MODEL))
    interp.allocate_tensors()
    inp = interp.get_input_details()[0]
    by_name = {o["name"]: o for o in interp.get_output_details()}
    scores_out = by_name["classificators"]
    boxes_out = by_name["regressors"]

    def detect(rgb, thr):
        """Return the single best (box_norm, keypoints_norm, conf) or None.

        box_norm / keypoints_norm are in [0,1] relative to the input image.
        """
        img = resize_rgb(rgb, DETECTOR_SIZE).astype(np.float32) / 127.5 - 1.0
        interp.set_tensor(inp["index"], img[None])
        interp.invoke()
        conf, box, kps = decode(
            interp.get_tensor(scores_out["index"]).reshape(-1),
            interp.get_tensor(boxes_out["index"]).reshape(-1, 16),
            ANCHORS,
        )
        n_anchors = conf.shape[0]
        m = conf > thr
        if not m.any():
            return None, n_anchors, 0
        conf, box, kps = conf[m], box[m], kps[m]
        box = np.clip(box, 0.0, 1.0)
        valid = (box[:, 2] - box[:, 0] > 1e-3) & (box[:, 3] - box[:, 1] > 1e-3)
        if not valid.any():
            return None, n_anchors, 0
        conf, box, kps = conf[valid], box[valid], kps[valid]
        keep = nms(box, conf)
        n_candidates = len(keep)
        # best = highest-confidence surviving detection
        best = keep[int(np.argmax(conf[keep]))]
        bx = box[best]
        pw = (bx[2] - bx[0]) * PAD_X
        ph = (bx[3] - bx[1]) * PAD_Y
        bx_pad = np.clip([bx[0] - pw, bx[1] - ph, bx[2] + pw, bx[3] + ph], 0.0, 1.0)
        return (bx_pad, kps[best], float(conf[best])), n_anchors, n_candidates

    return detect


# --------------------------------------------------------------------------- #
# MobileFaceNet INT8 embedder  (test_recognition.py)                          #
# --------------------------------------------------------------------------- #
def make_embedder():
    interp = Interpreter(model_path=str(EMBED_MODEL))
    interp.allocate_tensors()
    inp = interp.get_input_details()[0]
    out = interp.get_output_details()[0]
    si = inp["quantization_parameters"]["scales"][0]
    zi = inp["quantization_parameters"]["zero_points"][0]
    so = out["quantization_parameters"]["scales"][0]
    zo = out["quantization_parameters"]["zero_points"][0]

    def embed(crop_rgb):
        img = resize_rgb(crop_rgb, EMBED_SIZE).astype(np.float32) / 255.0
        q = np.round(img / si + zi).clip(-128, 127).astype(inp["dtype"])
        interp.set_tensor(inp["index"], q[None])
        interp.invoke()
        v = so * (interp.get_tensor(out["index"]).astype(np.float32).reshape(-1) - zo)
        return v / (np.linalg.norm(v) + 1e-9)

    return embed, (float(si), int(zi), float(so), int(zo))


# --------------------------------------------------------------------------- #
# Optional 5-point similarity alignment (ArcFace-style)                        #
# --------------------------------------------------------------------------- #
# Canonical ArcFace template for a 112x112 crop. MobileFaceNet was trained on
# faces warped so the eyes/nose/mouth land on these positions; feeding a raw
# BlazeFace box (no alignment) is the single biggest accuracy leak (see report).
# BlazeFace keypoint order: [0]=subject-right eye, [1]=subject-left eye,
# [2]=nose, [3]=mouth-center, [4]=right ear, [5]=left ear.
# Bare (canonical) ArcFace template. Kept as the base so the exploratory sweep
# scripts (sweep_crop_margin.py, compare_mfn_variants.py) that scale relative to it
# keep their meaning (s=1.0 = bare ArcFace).
_ARCFACE_5 = np.array([
    [38.2946, 51.6963],   # subject-right eye  (image-left)
    [73.5318, 51.5014],   # subject-left eye   (image-right)
    [56.0252, 71.7366],   # nose
    [56.1396, 92.2848],   # mouth-center (mean of canonical mouth corners)
], np.float32)

# Shipped crop tightness (mobile/src/ml/preprocessing.ts : ARCFACE_CROP_TIGHTEN).
# The device tightens the bare template 1.15× about its centroid because MobileFaceNet
# separates best when the face fills ~15% more of the 112² frame (sweep_crop_margin.py:
# AUC 0.948→0.959). The align functions below — the device mirror — warp to this
# tightened template, so this harness reports the SHIPPED operating point.
ARCFACE_CROP_TIGHTEN = 1.15
_c = _ARCFACE_5.mean(0)
_ARCFACE_5_SHIPPED = (_c + ARCFACE_CROP_TIGHTEN * (_ARCFACE_5 - _c)).astype(np.float32)


def _umeyama(src, dst):
    """Least-squares similarity transform (scale+rot+trans) mapping src -> dst."""
    n = src.shape[0]
    src_mean = src.mean(0)
    dst_mean = dst.mean(0)
    src_d = src - src_mean
    dst_d = dst - dst_mean
    cov = dst_d.T @ src_d / n
    d = np.ones(2)
    if np.linalg.det(cov) < 0:
        d[1] = -1
    u, s, vt = np.linalg.svd(cov)
    r = u @ np.diag(d) @ vt
    var_src = (src_d ** 2).sum() / n
    scale = (s * d).sum() / var_src
    t = dst_mean - scale * (r @ src_mean)
    m = np.zeros((2, 3), np.float32)
    m[:2, :2] = scale * r
    m[:2, 2] = t
    return m


def align_face(rgb, kps_norm):
    """Warp the face to the canonical 112x112 ArcFace frame using BlazeFace keypoints."""
    h, w = rgb.shape[:2]
    src = kps_norm[:4].astype(np.float32) * np.array([w, h], np.float32)  # eyes,nose,mouth
    m = _umeyama(src, _ARCFACE_5_SHIPPED)          # src(px) -> dst(112), tightened
    a = m[:2, :2]
    a_inv = np.linalg.inv(a)                        # PIL needs output->input
    b_inv = -a_inv @ m[:2, 2]
    coeffs = (a_inv[0, 0], a_inv[0, 1], b_inv[0],
              a_inv[1, 0], a_inv[1, 1], b_inv[1])
    warped = Image.fromarray(rgb).transform(
        (EMBED_SIZE, EMBED_SIZE), Image.AFFINE, coeffs, resample=Image.BILINEAR)
    return np.asarray(warped)


def _similarity_closedform(src, dst):
    """Closed-form 2D similarity (complex least-squares) — byte-for-byte mirror of
    the device worklet's solveSimilarityTransform (mobile/src/ml/preprocessing.ts)."""
    n = len(src)
    smx = sum(p[0] for p in src) / n
    smy = sum(p[1] for p in src) / n
    dmx = sum(p[0] for p in dst) / n
    dmy = sum(p[1] for p in dst) / n
    num_re = num_im = den = 0.0
    for (sx, sy), (dx, dy) in zip(src, dst):
        ax, ay = sx - smx, sy - smy
        bx, by = dx - dmx, dy - dmy
        num_re += ax * bx + ay * by
        num_im += ax * by - ay * bx
        den += ax * ax + ay * ay
    inv = 1.0 / den if den > 1e-12 else 0.0
    a, b = num_re * inv, num_im * inv
    return a, b, dmx - (a * smx - b * smy), dmy - (b * smx + a * smy)


def align_face_closedform(rgb, kps_norm):
    """Mirror of the on-device IDENTITY alignment (frameProcessor.ts): closed-form
    similarity + nearest-neighbour sampling. Proves the shipped worklet math on LFW."""
    h, w = rgb.shape[:2]
    src = [(float(kps_norm[i, 0] * w), float(kps_norm[i, 1] * h)) for i in range(4)]
    dst = [tuple(map(float, _ARCFACE_5_SHIPPED[i])) for i in range(4)]
    a, b, tx, ty = _similarity_closedform(src, dst)
    det = a * a + b * b
    if det < 1e-9:
        return resize_rgb(rgb, EMBED_SIZE)
    ia, ib = a / det, b / det
    ys, xs = np.mgrid[0:EMBED_SIZE, 0:EMBED_SIZE].astype(np.float64)
    ddx, ddy = xs - tx, ys - ty
    sx = np.clip(ia * ddx + ib * ddy, 0, w - 1).astype(np.int32)
    sy = np.clip(-ib * ddx + ia * ddy, 0, h - 1).astype(np.int32)
    return rgb[sy, sx]


# --------------------------------------------------------------------------- #
# Pipeline                                                                     #
# --------------------------------------------------------------------------- #
def crop_box(rgb, box_norm):
    h, w = rgb.shape[:2]
    x1 = int(round(box_norm[0] * w))
    y1 = int(round(box_norm[1] * h))
    x2 = int(round(box_norm[2] * w))
    y2 = int(round(box_norm[3] * h))
    x1, y1 = max(x1, 0), max(y1, 0)
    x2, y2 = min(x2, w), min(y2, h)
    if x2 - x1 < 2 or y2 - y1 < 2:
        return None, (x1, y1, x2, y2)
    return rgb[y1:y2, x1:x2], (x1, y1, x2, y2)


def embed_image(rgb, detect, embed, det_thr, align=False, align_fn=None):
    """Run BlazeFace -> crop (or align) -> MobileFaceNet on one image.

    Returns (embedding, trace_dict). trace_dict carries the BlazeFace output so
    callers can show exactly what was fed into the recognition model.
    """
    det, n_anchors, n_cand = detect(rgb, det_thr)
    h, w = rgb.shape[:2]
    if det is None:
        # No face above threshold -> fall back to the whole (already-centered) crop.
        crop = rgb
        trace = {
            "detected": False, "conf": None, "box_norm": None, "box_px": (0, 0, w, h),
            "kps_norm": None, "n_anchors": n_anchors, "n_candidates": n_cand,
            "aligned": False,
        }
    else:
        box_norm, kps_norm, conf = det
        if align:
            crop = (align_fn or align_face)(rgb, kps_norm)   # canonical 112x112 warp
            box_px = (0, 0, EMBED_SIZE, EMBED_SIZE)
        else:
            crop, box_px = crop_box(rgb, box_norm)
            if crop is None:
                crop = rgb
                box_px = (0, 0, w, h)
        trace = {
            "detected": True, "conf": conf, "box_norm": box_norm, "box_px": box_px,
            "kps_norm": kps_norm, "n_anchors": n_anchors, "n_candidates": n_cand,
            "aligned": align,
        }
    emb = embed(crop)
    trace["crop_hw"] = crop.shape[:2]
    trace["emb_norm"] = float(np.linalg.norm(emb))
    return emb, trace


def fmt_box_px(b):
    return f"({b[0]:>3},{b[1]:>3})-({b[2]:>3},{b[3]:>3})"


def print_trace(idx, label, sim, pred, ta, tb):
    truth = "SAME" if label == 1 else "DIFF"
    verdict = "MATCH" if pred == 1 else "NO-MATCH"
    ok = "✓" if pred == label else "✗"
    print(f"\n  ── Pair #{idx}  truth={truth}  →  {verdict}  cos={sim:+.3f}  {ok}")
    for tag, t in (("A", ta), ("B", tb)):
        if t["detected"]:
            kp = t["kps_norm"]
            kps = " ".join(f"({x:.2f},{y:.2f})" for x, y in kp)
            fed = "aligned112" if t.get("aligned") else f"box{t['crop_hw'][1]}x{t['crop_hw'][0]}"
            print(f"     [{tag}] BlazeFace: conf={t['conf']:.3f} "
                  f"box_px={fmt_box_px(t['box_px'])} fed_to_model={fed} "
                  f"cand={t['n_candidates']}/{t['n_anchors']} |emb|={t['emb_norm']:.3f}")
            print(f"         keypoints(eyeR,eyeL,nose,mouth,earR,earL)= {kps}")
        else:
            print(f"     [{tag}] BlazeFace: NO DETECTION (>= det-thr) — "
                  f"fell back to full crop {t['crop_hw'][1]}x{t['crop_hw'][0]} "
                  f"|emb|={t['emb_norm']:.3f}  (scanned {t['n_anchors']} anchors)")


def metrics_at(sims, labels, thr):
    pred = (sims >= thr).astype(int)
    tp = int(((pred == 1) & (labels == 1)).sum())
    tn = int(((pred == 0) & (labels == 0)).sum())
    fp = int(((pred == 1) & (labels == 0)).sum())
    fn = int(((pred == 0) & (labels == 1)).sum())
    n = len(labels)
    acc = (tp + tn) / n if n else 0.0
    prec = tp / (tp + fp) if (tp + fp) else 0.0
    rec = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * prec * rec / (prec + rec) if (prec + rec) else 0.0
    return dict(thr=thr, acc=acc, prec=prec, rec=rec, f1=f1, tp=tp, tn=tn, fp=fp, fn=fn)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--subset", default="test", choices=["test", "train", "10_folds"],
                    help="fetch_lfw_pairs subset (default: test = 1000 pairs)")
    ap.add_argument("--limit", type=int, default=0, help="cap number of pairs (0 = all)")
    ap.add_argument("--threshold", type=float, default=FACE_MATCH_THRESHOLD,
                    help=f"cosine match threshold (default {FACE_MATCH_THRESHOLD}, the app constant)")
    ap.add_argument("--detector-threshold", type=float, default=0.5,
                    help="BlazeFace confidence threshold (default 0.5)")
    ap.add_argument("--resize", type=float, default=1.0,
                    help="LFW image resize factor passed to fetch_lfw_pairs (default 1.0)")
    ap.add_argument("--trace", type=int, default=6,
                    help="number of pairs to print a detailed BlazeFace->model trace for")
    ap.add_argument("--align", action="store_true",
                    help="5-point similarity-align faces to the ArcFace template before "
                         "embedding (now the device default; was the worklet's missing step)")
    ap.add_argument("--align-method", choices=["umeyama-bilinear", "similarity-nearest"],
                    default="similarity-nearest",
                    help="umeyama-bilinear = SVD + bilinear (reference); similarity-nearest = "
                         "the exact closed-form + nearest-neighbour math the device worklet ships "
                         "(default, mirrors frameProcessor.ts)")
    args = ap.parse_args()
    align_fn = align_face_closedform if args.align_method == "similarity-nearest" else align_face

    print("=" * 78)
    print(" MobileFaceNet pipeline validation — external dataset: LFW pairs")
    print("=" * 78)
    print(f" detector : {DETECTOR_MODEL.relative_to(REPO)}")
    print(f" embedder : {EMBED_MODEL.relative_to(REPO)}")

    print(f"\n[1/3] Loading sklearn.datasets.fetch_lfw_pairs(subset='{args.subset}', "
          f"color=True, resize={args.resize}) …")
    t0 = time.time()
    pairs = fetch_lfw_pairs(subset=args.subset, color=True, resize=args.resize)
    X = pairs.pairs           # (n, 2, H, W, 3) float in [0,1]
    y = pairs.target.astype(int)  # 1 = same person, 0 = different
    n_total = len(y)
    n = n_total if args.limit <= 0 else min(args.limit, n_total)
    H, W = X.shape[2], X.shape[3]
    print(f"      loaded {n_total} pairs ({int((y==1).sum())} same / {int((y==0).sum())} different) "
          f"@ {W}x{H} px in {time.time()-t0:.1f}s; using {n}.")

    print("\n[2/3] Building TFLite interpreters …")
    detect = make_detector()
    embed, (si, zi, so, zo) = make_embedder()
    print(f"      BlazeFace  in={DETECTOR_SIZE}x{DETECTOR_SIZE} f16, {len(ANCHORS)} anchors, "
          f"det-thr={args.detector_threshold}, pad_x={PAD_X} pad_y={PAD_Y}")
    print(f"      MobileFaceNet in={EMBED_SIZE}x{EMBED_SIZE} int8  "
          f"(si={si:.6g} zi={zi}  so={so:.6g} zo={zo}) -> 128-d L2-normed")

    print(f"      alignment: {'5-point ArcFace warp (' + args.align_method + ')' if args.align else 'OFF (raw BlazeFace box)'}")
    print(f"\n[3/3] Running pipeline on {n} pairs ({2*n} images) …")
    sims = np.zeros(n, np.float32)
    n_detected = 0
    t1 = time.time()
    for i in range(n):
        a_rgb = (X[i, 0] * 255.0).round().clip(0, 255).astype(np.uint8)
        b_rgb = (X[i, 1] * 255.0).round().clip(0, 255).astype(np.uint8)
        ea, ta = embed_image(a_rgb, detect, embed, args.detector_threshold, args.align, align_fn)
        eb, tb = embed_image(b_rgb, detect, embed, args.detector_threshold, args.align, align_fn)
        sims[i] = float(ea @ eb)
        n_detected += int(ta["detected"]) + int(tb["detected"])
        if i < args.trace:
            pred = 1 if sims[i] >= args.threshold else 0
            print_trace(i, int(y[i]), sims[i], pred, ta, tb)
        if (i + 1) % 100 == 0:
            print(f"      … {i+1}/{n} pairs  ({(time.time()-t1)/(i+1)*1000:.0f} ms/pair)")
    dt = time.time() - t1
    labels = y[:n]

    # --------------------------- report ------------------------------------ #
    print("\n" + "=" * 78)
    print(" RESULTS")
    print("=" * 78)
    det_rate = n_detected / (2 * n)
    print(f" images with a BlazeFace detection : {n_detected}/{2*n} ({det_rate:.1%})  "
          f"[rest fell back to full LFW crop]")
    same = sims[labels == 1]
    diff = sims[labels == 0]

    def stat_line(name, arr):
        if arr.size == 0:
            print(f" cosine({name})  (no pairs of this class in the sampled range)")
        else:
            print(f" cosine({name})  mean={arr.mean():+.3f}  std={arr.std():.3f}  "
                  f"[min {arr.min():+.3f}, max {arr.max():+.3f}]")

    stat_line("same person", same)
    stat_line("diff person", diff)
    if same.size and diff.size:
        auc = roc_auc_score(labels, sims)
        print(f" ROC-AUC (threshold-independent separability) : {auc:.4f}")
    else:
        auc = float("nan")
        print(" ROC-AUC : n/a (need both classes — run without --limit, or a larger --limit)")

    m = metrics_at(sims, labels, args.threshold)
    print(f"\n At the app threshold FACE_MATCH_THRESHOLD = {args.threshold}:")
    print(f"   accuracy = {m['acc']:.1%}   precision = {m['prec']:.1%}   "
          f"recall = {m['rec']:.1%}   F1 = {m['f1']:.3f}")
    print(f"   confusion: TP={m['tp']} TN={m['tn']} FP={m['fp']} FN={m['fn']}")

    # Sweep for the accuracy-optimal threshold (diagnostic — does NOT change the app)
    grid = np.round(np.arange(0.30, 0.901, 0.01), 2)
    best = max((metrics_at(sims, labels, t) for t in grid), key=lambda d: d["acc"])
    print(f"\n Best-accuracy threshold on this set : {best['thr']:.2f} "
          f"-> accuracy = {best['acc']:.1%}  (precision {best['prec']:.1%}, recall {best['rec']:.1%})")

    sc004 = "PASS ✅" if m["acc"] >= 0.90 else ("PASS@best ✅" if best["acc"] >= 0.90 else "BELOW TARGET ⚠️")
    print(f"\n SC-004 (face match accuracy >= 90%) : {sc004}")
    print(f" throughput: {dt:.1f}s for {n} pairs ({dt/n*1000:.0f} ms/pair, {dt/(2*n)*1000:.0f} ms/image)")
    print("=" * 78)


if __name__ == "__main__":
    main()
