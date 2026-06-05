#!/usr/bin/env python3
"""Validate the NEW MiniFASNetV2SE ONNX vs the shipped TFLite anti-spoof models on
the REALISTIC full-frame PAD set (Real/ selfies + Spoof/ screen-replay video frames).

Unlike LiveSpoofDataset (tight 112² crops with NO surround), this set has genuine
full-frame selfies and screen-replay recaptures WITH bezels / moiré / screen edges —
the recapture cues MiniFASNet actually keys on. We run the device pipeline:

    BlazeFace detect -> ANTISPOOF_CROP_SCALE box-centred square crop (surround
    comes along) -> resize 128 -> RGB /255 -> classifier -> realProb = softmax[0]

The SAME crop is fed to every model (ONNX + int8/f16/f32 TFLite) so the comparison
is exact. Bona-fide = Real/*.jpg ; attacks = Spoof/frames/*.jpg (extracted by
scripts/extract_spoof_frames.py).

Run:  .venv-convert/bin/python3 scripts/validate_antispoof_realset.py
      .venv-convert/bin/python3 scripts/validate_antispoof_realset.py --crop-scale 1.0 1.5 2.0 2.7
"""
import argparse
import pathlib
import time

import numpy as np
import onnxruntime as ort
from ai_edge_litert.interpreter import Interpreter
from PIL import Image
from sklearn.metrics import roc_auc_score

# reuse the validated BlazeFace detector + crop helpers + metrics
from validate_antispoof import (
    REPO, DETECTOR_MODEL, ANTISPOOF_MODELS, ANTISPOOF_SIZE,
    make_detector, scaled_square_crop, center_square, pad_metrics,
)

ONNX = REPO / "models" / "antispoof_model.onnx"


def resize_rgb(rgb_u8, size):
    return np.asarray(Image.fromarray(rgb_u8).resize((size, size), Image.BILINEAR))


def softmax2(x):
    e = np.exp(x - x.max())
    return e / e.sum()


def load_dir(path, limit):
    exts = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
    files = sorted(p for p in pathlib.Path(path).rglob("*") if p.suffix.lower() in exts)
    if limit > 0:
        files = files[:limit]
    out = []
    for f in files:
        try:
            out.append(np.asarray(Image.open(f).convert("RGB")))
        except Exception as e:  # noqa: BLE001
            print(f"   ! skipped {f.name}: {e}")
    return out


def make_onnx_classifier():
    sess = ort.InferenceSession(str(ONNX), providers=["CPUExecutionProvider"])
    iname = sess.get_inputs()[0].name

    def classify(crop_rgb):  # RGB /255, NCHW, realProb = p[0]
        img = (resize_rgb(crop_rgb, ANTISPOOF_SIZE).astype(np.float32) / 255.0)
        x = np.ascontiguousarray(img.transpose(2, 0, 1)[None], np.float32)
        lg = sess.run(None, {iname: x})[0].reshape(-1)
        return float(softmax2(lg)[0])

    return classify


def make_tflite_classifier(path):
    it = Interpreter(model_path=str(path))
    it.allocate_tensors()
    inp = it.get_input_details()[0]
    out = it.get_output_details()[0]

    def classify(crop_rgb):  # RGB /255, NHWC, realProb = p[0]
        img = (resize_rgb(crop_rgb, ANTISPOOF_SIZE).astype(np.float32) / 255.0)
        it.set_tensor(inp["index"], img[None])
        it.invoke()
        return float(softmax2(it.get_tensor(out["index"]).astype(np.float32).reshape(-1))[0])

    return classify


def get_crop(rgb, detect, det_thr, crop_scale):
    """Device path: BlazeFace -> crop_scale box crop, else centre square."""
    box_norm, conf = detect(rgb, det_thr)
    if box_norm is None:
        return center_square(rgb), False
    crop, _ = scaled_square_crop(rgb, box_norm, crop_scale)
    if crop is None:
        return center_square(rgb), True
    return crop, True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--live-dir", default=str(REPO / "Real"))
    ap.add_argument("--spoof-dir", default=str(REPO / "Spoof" / "frames"))
    ap.add_argument("--limit", type=int, default=0, help="cap per class (0=all)")
    ap.add_argument("--detector-threshold", type=float, default=0.5)
    ap.add_argument("--crop-scale", type=float, nargs="+", default=[1.5],
                    help="box-centred crop scale(s) to sweep (device ANTISPOOF_CROP_SCALE = 1.5)")
    ap.add_argument("--threshold", type=float, default=0.85,
                    help="realProb gate (device LIVENESS_ANTISPOOF_REAL_THRESHOLD = 0.85)")
    args = ap.parse_args()

    print("=" * 92)
    print(" Anti-spoof on REALISTIC full-frame PAD: NEW ONNX vs shipped TFLite (int8/f16/f32)")
    print(f" bona-fide: {args.live_dir}   attacks: {args.spoof_dir}")
    print(f" pipeline : BlazeFace -> crop -> RGB/255 -> realProb=softmax[0], gate={args.threshold}")
    print("=" * 92)

    print("\n[1/4] Loading images …")
    t0 = time.time()
    live = load_dir(args.live_dir, args.limit)
    spoof = load_dir(args.spoof_dir, args.limit)
    print(f"      bona-fide {len(live)} | attacks {len(spoof)}  ({time.time()-t0:.1f}s)")

    print("[2/4] Building detector + classifiers …")
    detect = make_detector()
    classifiers = {"onnx(new)": make_onnx_classifier()}
    for name, path in ANTISPOOF_MODELS.items():
        if path.exists():
            classifiers[f"tflite-{name}"] = make_tflite_classifier(path)
    print(f"      detector {DETECTOR_MODEL.name}; classifiers: {list(classifiers)}")

    grid = np.round(np.arange(0.05, 0.951, 0.05), 2)
    for cs in args.crop_scale:
        print(f"\n[3/4] crop-scale = {cs} : detect -> crop -> classify (same crop, all models)")
        # crop every image once
        live_crops, ldet = [], 0
        for im in live:
            c, d = get_crop(im, detect, args.detector_threshold, cs)
            live_crops.append(c); ldet += int(d)
        spoof_crops, sdet = [], 0
        for im in spoof:
            c, d = get_crop(im, detect, args.detector_threshold, cs)
            spoof_crops.append(c); sdet += int(d)
        print(f"      BlazeFace detected: bona-fide {ldet}/{len(live)}, attack {sdet}/{len(spoof)}"
              f"  (rest -> centre crop)")

        print(f"\n  {'model':>12} | {'live μ':>7} {'spoof μ':>7} | {'AUC':>7} | "
              f"{'SC-003':>7} {'APCER':>6} {'BPCER':>6} {'ACER':>6} | {'bestACER@thr':>13} {'verdict':>7}")
        print("  " + "-" * 100)
        for name, clf in classifiers.items():
            lp = np.array([clf(c) for c in live_crops], np.float32)
            sp = np.array([clf(c) for c in spoof_crops], np.float32)
            y = np.r_[np.ones_like(lp), np.zeros_like(sp)]
            auc = roc_auc_score(y, np.r_[lp, sp])
            m = pad_metrics(lp, sp, args.threshold)
            best = min((pad_metrics(lp, sp, t) for t in grid), key=lambda d: d["acer"])
            verdict = "PASS✅" if m["rej"] >= 0.95 else "below"
            print(f"  {name:>12} | {lp.mean():7.3f} {sp.mean():7.3f} | {auc:7.4f} | "
                  f"{m['rej']:7.1%} {m['apcer']:6.1%} {m['bpcer']:6.1%} {m['acer']:6.1%} | "
                  f"{best['acer']:6.1%}@{best['thr']:.2f}  {verdict:>7}")

    print("\n[4/4] done.")
    print("=" * 92)


if __name__ == "__main__":
    main()
