#!/usr/bin/env python3
"""Live webcam test for the INT8 MobileFaceNet recognition model.

Model : models/MobileFaceNet_new_latest_int8.tflite
Input : int8 [1,112,112,3]   (RGB normalized to [0,1] then quantized; int8 = px-128)
Output: int8 [1,128] -> 128-dim embedding (dequantized, then L2-normalized)

PREPROCESSING — mirrors the shipped device pipeline (mobile/src/ml/preprocessing.ts,
validate_recognition_lfw.py), NOT a raw detector box:

    frame (BGR)
      -> BlazeFace short-range f16    (best face box + 6 keypoints; test_blazeface_f16)
      -> 5-point ArcFace similarity-align the eyes/nose/mouth to the canonical 112x112
         template, TIGHTENED 1.15x  (ARCFACE_CROP_TIGHTEN — MobileFaceNet separates best
         when the face fills ~15% more of the frame; alignment is the single biggest
         recognition-accuracy factor, so a raw bbox crop is "wrong" preprocessing)
      -> MobileFaceNet INT8           (px/255 -> affine int8 quant -> L2-normed 128-d)

Press 'e' to enroll the current face as the reference; the script then shows live
cosine similarity vs that reference and a MATCH / NO MATCH verdict at --threshold
(default 0.45 = the shipped FACE_MATCH_THRESHOLD). Press 'q' to quit.
  python scripts/test_recognition.py
  python scripts/test_recognition.py --selftest
"""
import argparse
import pathlib
import sys
import time

import cv2
import numpy as np
from ai_edge_litert.interpreter import Interpreter

REPO = pathlib.Path(__file__).resolve().parent.parent
MODEL = REPO / "models" / "MobileFaceNet_new_latest_int8.tflite"
SIZE = 112

# Reuse the f16 BlazeFace detector (gives the 5 keypoints alignment needs), exactly
# as test_facemesh_f16.py does — keeps detection identical to test_blazeface_f16.py.
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from test_blazeface_f16 import make_detector as make_face_detector  # noqa: E402

# --------------------------------------------------------------------------- #
# 5-point ArcFace alignment (mirror of preprocessing.ts / validate_recognition_lfw) #
# --------------------------------------------------------------------------- #
# Canonical ArcFace template (subject-right eye, subject-left eye, nose, mouth-centre)
# for a 112x112 crop, tightened 1.15x about its centroid = the SHIPPED template.
_ARCFACE_5 = np.array([
    [38.2946, 51.6963],
    [73.5318, 51.5014],
    [56.0252, 71.7366],
    [56.1396, 92.2848],
], np.float32)
ARCFACE_CROP_TIGHTEN = 1.15
_c = _ARCFACE_5.mean(0)
_ARCFACE_DST = (_c + ARCFACE_CROP_TIGHTEN * (_ARCFACE_5 - _c)).astype(np.float32)


def _similarity_closedform(src, dst):
    """Closed-form 2D similarity (complex least-squares) — mirror of the device
    worklet's solveSimilarityTransform (mobile/src/ml/preprocessing.ts)."""
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


def align_face(rgb, kps_px):
    """Warp the face to the tightened 112x112 ArcFace frame using the first 4
    BlazeFace keypoints (eyes, nose, mouth), given in pixel coords. Closed-form
    similarity + nearest sampling — byte-for-byte the device IDENTITY path."""
    h, w = rgb.shape[:2]
    src = [(float(kps_px[i][0]), float(kps_px[i][1])) for i in range(4)]
    dst = [tuple(map(float, _ARCFACE_DST[i])) for i in range(4)]
    a, b, tx, ty = _similarity_closedform(src, dst)
    det = a * a + b * b
    if det < 1e-9:
        return cv2.resize(rgb, (SIZE, SIZE))
    ia, ib = a / det, b / det
    ys, xs = np.mgrid[0:SIZE, 0:SIZE].astype(np.float64)
    ddx, ddy = xs - tx, ys - ty
    sx = np.clip(ia * ddx + ib * ddy, 0, w - 1).astype(np.int32)
    sy = np.clip(-ib * ddx + ia * ddy, 0, h - 1).astype(np.int32)
    return rgb[sy, sx]


def make_embedder():
    interp = Interpreter(model_path=str(MODEL))
    interp.allocate_tensors()
    inp = interp.get_input_details()[0]
    out = interp.get_output_details()[0]
    si, zi = inp["quantization_parameters"]["scales"][0], inp["quantization_parameters"]["zero_points"][0]
    so, zo = out["quantization_parameters"]["scales"][0], out["quantization_parameters"]["zero_points"][0]

    def embed(crop_rgb):
        img = cv2.resize(crop_rgb, (SIZE, SIZE)).astype(np.float32) / 255.0
        q = np.round(img / si + zi).clip(-128, 127).astype(inp["dtype"])
        interp.set_tensor(inp["index"], q[None])
        interp.invoke()
        v = so * (interp.get_tensor(out["index"]).astype(np.float32).reshape(-1) - zo)
        return v / (np.linalg.norm(v) + 1e-9)

    return embed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--camera", type=int, default=0)
    ap.add_argument("--threshold", type=float, default=0.45,
                    help="cosine match threshold (default 0.45 = shipped FACE_MATCH_THRESHOLD)")
    ap.add_argument("--det-threshold", type=float, default=0.6,
                    help="BlazeFace confidence threshold (default 0.6)")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    embed = make_embedder()

    if args.selftest:
        # Exercise the full import + both interpreters: detector on a noise frame
        # (expects no face), then two embeddings to report self/other cosine.
        detect = make_face_detector()
        noise = (np.random.rand(480, 640, 3) * 255).astype(np.uint8)
        t = time.time()
        dets = detect(noise, args.det_threshold)
        e1 = embed((np.random.rand(200, 200, 3) * 255).astype(np.uint8))
        e2 = embed((np.random.rand(200, 200, 3) * 255).astype(np.uint8))
        print(f"[selftest] BlazeFace+MobileFaceNet OK in {(time.time()-t)*1000:.1f} ms, "
              f"{len(dets)} faces on noise, dim={e1.shape[0]}, |e|={np.linalg.norm(e1):.3f}, "
              f"cos(noise1,noise2)={float(e1 @ e2):.3f}")
        return

    detect = make_face_detector()
    cap = cv2.VideoCapture(args.camera)
    if not cap.isOpened():
        raise SystemExit(f"Cannot open camera {args.camera}")
    ref = None
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        t = time.time()
        dets = detect(frame, args.det_threshold)
        cur = None
        if dets:
            b, kps, conf = max(dets, key=lambda d: d[2])
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            crop = align_face(rgb, kps)            # 112x112 aligned RGB
            cur = embed(crop)
            cv2.rectangle(frame, (b[0], b[1]), (b[2], b[3]), (0, 255, 0), 2)
            for (kx, ky) in kps[:4]:
                cv2.circle(frame, (int(kx), int(ky)), 2, (0, 0, 255), -1)
            if ref is not None:
                sim = float(cur @ ref)
                ok_match = sim >= args.threshold
                col = (0, 255, 0) if ok_match else (0, 0, 255)
                label = "MATCH" if ok_match else "NO MATCH"
                cv2.putText(frame, f"{label}  cos={sim:.3f}", (b[0], max(b[1] - 8, 12)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.6, col, 2)
        msg = "press 'e' to enroll" if ref is None else "enrolled - press 'e' to re-enroll"
        fps = 1.0 / max(time.time() - t, 1e-6)
        cv2.putText(frame, f"MobileFaceNet INT8 (aligned)  {fps:5.1f} FPS", (10, 25),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 0), 2)
        cv2.putText(frame, msg, (10, 50), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (200, 200, 200), 1)
        cv2.imshow("MobileFaceNet INT8 (q to quit)", frame)
        key = cv2.waitKey(1) & 0xFF
        if key == ord("q"):
            break
        if key == ord("e") and cur is not None:
            ref = cur
    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
