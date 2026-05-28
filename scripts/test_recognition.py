#!/usr/bin/env python3
"""Live webcam test for the INT8 MobileFaceNet recognition model.

Model : models/MobileFaceNet_new_latest_int8.tflite
Input : int8 [1,112,112,3]   (RGB normalized to [0,1] then quantized; int8 = px-128)
Output: int8 [1,128] -> 128-dim embedding (dequantized, then L2-normalized)

A Haar cascade crops the face. Press 'e' to enroll the current face as the
reference; the script then shows live cosine similarity vs that reference and a
MATCH / NO MATCH verdict at --threshold. Press 'q' to quit.
  python scripts/test_recognition.py
  python scripts/test_recognition.py --selftest
"""
import argparse
import pathlib
import time

import cv2
import numpy as np
from ai_edge_litert.interpreter import Interpreter

REPO = pathlib.Path(__file__).resolve().parent.parent
MODEL = REPO / "models" / "MobileFaceNet_new_latest_int8.tflite"
SIZE = 112
HAAR = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")


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
    ap.add_argument("--threshold", type=float, default=0.5)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    embed = make_embedder()

    if args.selftest:
        f1 = (np.random.rand(200, 200, 3) * 255).astype(np.uint8)
        t = time.time()
        e1 = embed(f1)
        e2 = embed((np.random.rand(200, 200, 3) * 255).astype(np.uint8))
        print(f"[selftest] forward pass OK in {(time.time()-t)*1000:.1f} ms, "
              f"dim={e1.shape[0]}, |e|={np.linalg.norm(e1):.3f}, "
              f"cos(noise1,noise2)={float(e1 @ e2):.3f}")
        return

    cap = cv2.VideoCapture(args.camera)
    if not cap.isOpened():
        raise SystemExit(f"Cannot open camera {args.camera}")
    ref = None
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        t = time.time()
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        faces = HAAR.detectMultiScale(gray, 1.2, 5, minSize=(80, 80))
        cur = None
        if len(faces):
            x, y, w, h = max(faces, key=lambda f: f[2] * f[3])
            crop = cv2.cvtColor(frame[y:y + h, x:x + w], cv2.COLOR_BGR2RGB)
            if crop.size:
                cur = embed(crop)
                cv2.rectangle(frame, (x, y), (x + w, y + h), (0, 255, 0), 2)
                if ref is not None:
                    sim = float(cur @ ref)
                    ok_match = sim >= args.threshold
                    col = (0, 255, 0) if ok_match else (0, 0, 255)
                    label = "MATCH" if ok_match else "NO MATCH"
                    cv2.putText(frame, f"{label}  cos={sim:.3f}", (x, y - 8),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.6, col, 2)
        msg = "press 'e' to enroll" if ref is None else "enrolled - press 'e' to re-enroll"
        fps = 1.0 / max(time.time() - t, 1e-6)
        cv2.putText(frame, f"MobileFaceNet INT8  {fps:5.1f} FPS", (10, 25),
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
