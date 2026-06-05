#!/usr/bin/env python3
"""Live webcam test for the float16 FaceMesh landmark model.

Model : models/face_landmarks_detector_float16.tflite
Input : float32 [1,256,256,3]  RGB normalized to [0,1]
Output: float32 [1,1,1,1434]  478 landmarks (x,y,z) — pixel space [0,256]
        float32 [1,1,1,1]     face presence logit
        float32 [1,1]         face presence probability

Uses BlazeFace for detection. Press 'q' to quit.
  python scripts/test_facemesh_f16.py
  python scripts/test_facemesh_f16.py --selftest
"""
import argparse
import pathlib
import sys
import time

import cv2
import numpy as np
from ai_edge_litert.interpreter import Interpreter

REPO = pathlib.Path(__file__).resolve().parent.parent
MODEL = REPO / "models" / "face_landmarks_detector_float16.tflite"
SIZE = 256

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from test_blazeface_f16 import make_detector as make_face_detector  # noqa: E402


def make_landmarker():
    interp = Interpreter(model_path=str(MODEL))
    interp.allocate_tensors()
    inp = interp.get_input_details()[0]
    outs = interp.get_output_details()
    # largest tensor = landmarks (1434), smallest = score (1)
    lm_out    = max(outs, key=lambda o: int(np.prod(o["shape"])))
    score_out = min(outs, key=lambda o: int(np.prod(o["shape"])))

    def run(crop_rgb):
        img = cv2.resize(crop_rgb, (SIZE, SIZE)).astype(np.float32) / 255.0
        interp.set_tensor(inp["index"], img[None])
        interp.invoke()
        pts   = interp.get_tensor(lm_out["index"]).reshape(-1, 3)[:, :2]
        score = float(interp.get_tensor(score_out["index"]).reshape(-1)[0])
        return pts, score

    return run


def face_crop(frame, box, kps, pad=1.3):
    """Square padded crop centred on the face midpoint (eye-line ↔ mouth)."""
    x1b, y1b, x2b, y2b = box
    eye_mid = ((kps[0] + kps[1]) / 2).astype(int)
    mouth   = kps[3].astype(int)
    cx = int((eye_mid[0] + mouth[0]) / 2)
    cy = int((eye_mid[1] + mouth[1]) / 2)
    side = int(max(x2b - x1b, y2b - y1b) * pad)
    fh, fw = frame.shape[:2]
    x1 = max(cx - side // 2, 0)
    y1 = max(cy - side // 2, 0)
    x2 = min(cx + side // 2, fw)
    y2 = min(cy + side // 2, fh)
    return x1, y1, x2, y2


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--camera",    type=int,   default=0)
    ap.add_argument("--threshold", type=float, default=0.5)
    ap.add_argument("--selftest",  action="store_true")
    args = ap.parse_args()

    run = make_landmarker()

    if args.selftest:
        noise = (np.random.rand(200, 200, 3) * 255).astype(np.uint8)
        t = time.time()
        pts, score = run(cv2.cvtColor(noise, cv2.COLOR_BGR2RGB))
        print(f"[selftest] forward pass OK in {(time.time()-t)*1000:.1f} ms, "
              f"{pts.shape[0]} landmarks, presence score {score:.3f}")
        print(f"[selftest] lm x:[{pts[:,0].min():.1f}, {pts[:,0].max():.1f}]  "
              f"y:[{pts[:,1].min():.1f}, {pts[:,1].max():.1f}]")
        return

    detect = make_face_detector()
    cap = cv2.VideoCapture(args.camera)
    if not cap.isOpened():
        raise SystemExit(f"Cannot open camera {args.camera}")

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        t = time.time()
        dets = detect(frame, args.threshold)
        n = 0
        if dets:
            b, kps, conf = max(dets, key=lambda d: d[2])
            x1, y1, x2, y2 = face_crop(frame, b, kps)
            crop = cv2.cvtColor(frame[y1:y2, x1:x2], cv2.COLOR_BGR2RGB)
            if crop.size:
                pts, score = run(crop)
                cw, ch = x2 - x1, y2 - y1
                for px, py in pts:
                    cv2.circle(frame,
                               (int(x1 + px / SIZE * cw), int(y1 + py / SIZE * ch)),
                               1, (0, 255, 0), -1)
                n = len(pts)
                cv2.rectangle(frame, (x1, y1), (x2, y2), (255, 0, 0), 1)
                cv2.putText(frame, f"conf {conf:.2f}  score {score:.2f}",
                            (x1, y1 - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 0, 0), 1)
        fps = 1.0 / max(time.time() - t, 1e-6)
        cv2.putText(frame, f"FaceMesh f16  {fps:5.1f} FPS  pts:{n}",
                    (10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 0), 2)
        cv2.imshow("FaceMesh float16 (q to quit)", frame)
        if cv2.waitKey(1) & 0xFF == ord("q"):
            break

    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
