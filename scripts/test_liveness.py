#!/usr/bin/env -S /Users/abq/Documents/Github/Builds/NHAI/.venv/bin/python3
"""Live webcam test for the MobileNetV4 passive-liveness model.

Model : models/antispoof_128x128_float32.tflite
Input : float32 [1,128,128,3]  RGB, ImageNet-normalised
Output: float32 [1,2]          logits; class 0=spoof, class 1=real/live

Face crop: 1.5× Haar bbox, centred. Haar minSize=(60,60).
Draws REAL / SPOOF verdict + confidence live.
Hold a printed photo or phone screen to the camera to see spoof detection.
  python scripts/test_liveness.py
  python scripts/test_liveness.py --selftest
Press 'q' to quit.
"""
import argparse
import pathlib
import time

import cv2
import numpy as np
from ai_edge_litert.interpreter import Interpreter

REPO    = pathlib.Path(__file__).resolve().parent.parent
MODELS  = {
    "float32": REPO / "models" / "antispoof_128x128_float32.tflite",
    "float16": REPO / "models" / "antispoof_128x128_float16.tflite",
    "int8":    REPO / "models" / "antispoof_128x128_int8.tflite",
}
SIZE  = 128
SCALE = 1.5
HAAR  = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")

# ImageNet stats (RGB order, matching training transforms)
_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_STD  = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def softmax(x):
    e = np.exp(x - x.max())
    return e / e.sum()


def scaled_crop(frame, x, y, w, h, scale):
    """Return a (scale × bbox) centred square crop, clamped to frame bounds."""
    fh, fw = frame.shape[:2]
    cx, cy = x + w / 2, y + h / 2
    half = max(w, h) * scale / 2
    x0 = int(max(cx - half, 0))
    y0 = int(max(cy - half, 0))
    x1 = int(min(cx + half, fw))
    y1 = int(min(cy + half, fh))
    return frame[y0:y1, x0:x1], x0, y0, x1, y1


def make_classifier(model_path):
    interp = Interpreter(model_path=str(model_path))
    interp.allocate_tensors()
    inp = interp.get_input_details()[0]
    out = interp.get_output_details()[0]

    def classify(crop_bgr):
        rgb = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2RGB)
        img = cv2.resize(rgb, (SIZE, SIZE)).astype(np.float32) / 255.0
        img = (img - _MEAN) / _STD
        interp.set_tensor(inp["index"], img[None])
        interp.invoke()
        return softmax(interp.get_tensor(out["index"]).reshape(-1))

    return classify


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--camera", type=int, default=0)
    ap.add_argument("--model", choices=["float32", "float16", "int8"], default="float16")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    model_path = MODELS[args.model]
    print(f"Model: {model_path.name}")
    classify = make_classifier(model_path)

    if args.selftest:
        frame = (np.random.rand(200, 200, 3) * 255).astype(np.uint8)
        t = time.time()
        probs = classify(frame)
        print(f"[selftest] forward pass OK in {(time.time()-t)*1000:.1f} ms, "
              f"probs={np.round(probs, 3).tolist()}, argmax={int(probs.argmax())}")
        return

    cap = cv2.VideoCapture(args.camera)
    if not cap.isOpened():
        raise SystemExit(f"Cannot open camera {args.camera}")
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        t = time.time()
        gray  = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        faces = HAAR.detectMultiScale(gray, 1.2, 5, minSize=(60, 60))
        if len(faces):
            x, y, w, h = max(faces, key=lambda f: f[2] * f[3])
            crop, x0, y0, x1, y1 = scaled_crop(frame, x, y, w, h, SCALE)
            if crop.size:
                probs = classify(crop)
                live  = int(probs.argmax()) == 1
                conf  = float(probs[1])
                col   = (0, 255, 0) if live else (0, 0, 255)
                label = "REAL" if live else "SPOOF"
                cv2.rectangle(frame, (x0, y0), (x1, y1), col, 2)
                cv2.putText(frame, f"{label}  {conf:.2f}", (x0, max(y0 - 8, 10)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.6, col, 2)
        fps = 1.0 / max(time.time() - t, 1e-6)
        cv2.putText(frame, f"MobileNetV4 [{args.model}]  {fps:5.1f} FPS", (10, 25),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 0), 2)
        cv2.imshow("Liveness (q to quit)", frame)
        if cv2.waitKey(1) & 0xFF == ord("q"):
            break
    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
