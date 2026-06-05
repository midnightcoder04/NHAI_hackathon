#!/usr/bin/env python3
"""Live webcam test for the INT8 BlazeFace face detector.

Model : models/blaze_face_short_1x3x128x128_range_int8.tflite
Input : uint8 [1,128,128,3]  (quant scale 1/127.5, zp 127 -> feed raw RGB pixels)
Output: 512 + 384 anchor scores (logits) and 16-value box/keypoint regressors

Draws the detected face box + 6 BlazeFace keypoints (eyes, nose, mouth, ears) live.
  python scripts/test_blazeface.py                 # webcam
  python scripts/test_blazeface.py --selftest      # one synthetic frame, no camera
Press 'q' in the window to quit.
"""
import argparse
import pathlib
import time

import cv2
import numpy as np
from ai_edge_litert.interpreter import Interpreter

REPO = pathlib.Path(__file__).resolve().parent.parent
MODEL = REPO / "models" / "blaze_face_short_1x3x128x128_range_int8.tflite"
SIZE = 128


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


ANCHORS_A, ANCHORS_B = gen_anchors()


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


def make_smoother(alpha=0.4):
    """EMA smoother for box + keypoints. alpha=1.0 → no smoothing, lower → smoother/laggier."""
    state = {}

    def smooth(dets):
        if not dets:
            state.clear()
            return []
        b, k, c = max(dets, key=lambda d: d[2])
        bf = np.array(b, dtype=np.float32)
        kf = np.array(k, dtype=np.float32)
        if "box" not in state:
            state["box"] = bf
            state["kps"] = kf
        else:
            state["box"] = alpha * bf + (1 - alpha) * state["box"]
            state["kps"] = alpha * kf + (1 - alpha) * state["kps"]
        return [(state["box"].astype(int), state["kps"].astype(int), c)]

    return smooth


def make_detector():
    interp = Interpreter(model_path=str(MODEL))
    interp.allocate_tensors()
    inp = interp.get_input_details()[0]
    outs = interp.get_output_details()
    by_shape = {(int(np.prod(o["shape"])), int(o["shape"][-1])): o for o in outs}
    sA = by_shape[(512, 1)]
    sB = by_shape[(384, 1)]
    bA = by_shape[(512 * 16, 16)]
    bB = by_shape[(384 * 16, 16)]

    def deq(o):
        t = interp.get_tensor(o["index"])
        s, z = o["quantization_parameters"]["scales"], o["quantization_parameters"]["zero_points"]
        return s[0] * (t.astype(np.float32) - z[0])

    def detect(frame, thr, pad_x=0.00, pad_y=0.50):
        h, w = frame.shape[:2]
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        img = cv2.resize(rgb, (SIZE, SIZE))[None].astype(inp["dtype"])
        interp.set_tensor(inp["index"], img)
        interp.invoke()
        cA, bxA, kA = decode(deq(sA).reshape(-1), deq(bA).reshape(-1, 16), ANCHORS_A)
        cB, bxB, kB = decode(deq(sB).reshape(-1), deq(bB).reshape(-1, 16), ANCHORS_B)
        conf = np.concatenate([cA, cB])
        box = np.concatenate([bxA, bxB])
        kps = np.concatenate([kA, kB])
        m = conf > thr
        if not m.any():
            return []
        conf, box, kps = conf[m], box[m], kps[m]
        # clip boxes to [0, 1] — the second anchor set (8×8 grid) has degenerate
        # quantisation that can produce deltas spanning ±88× the image width
        box = np.clip(box, 0.0, 1.0)
        # drop zero-area boxes that result from clipping out-of-bound predictions
        valid = (box[:, 2] - box[:, 0] > 1e-3) & (box[:, 3] - box[:, 1] > 1e-3)
        if not valid.any():
            return []
        conf, box, kps = conf[valid], box[valid], kps[valid]
        keep = nms(box, conf)
        out = []
        for i in keep:
            bx = box[i]
            pw = (bx[2] - bx[0]) * pad_x
            ph = (bx[3] - bx[1]) * pad_y
            bx_pad = np.clip([bx[0] - pw, bx[1] - ph, bx[2] + pw, bx[3] + ph], 0.0, 1.0)
            b = (bx_pad * [w, h, w, h]).astype(int)
            k = (kps[i] * [w, h]).astype(int)
            out.append((b, k, float(conf[i])))
        return out

    return detect


def draw(frame, dets):
    for b, k, c in dets:
        cv2.rectangle(frame, (b[0], b[1]), (b[2], b[3]), (0, 255, 0), 2)
        cv2.putText(frame, f"{c:.2f}", (b[0], b[1] - 6),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)
        for (x, y) in k:
            cv2.circle(frame, (int(x), int(y)), 2, (0, 0, 255), -1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--camera", type=int, default=0)
    ap.add_argument("--threshold", type=float, default=0.6)
    ap.add_argument("--pad-x", type=float, default=0.00,
                    help="Horizontal box expansion per side (default 0.00)")
    ap.add_argument("--pad-y", type=float, default=0.50,
                    help="Vertical box expansion per side (default 0.50)")
    ap.add_argument("--ema-alpha", type=float, default=0.4,
                    help="EMA smoothing factor 0–1 (0=frozen, 1=no smoothing, default 0.4)")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    detect = make_detector()
    smooth = make_smoother(alpha=args.ema_alpha)

    if args.selftest:
        frame = (np.random.rand(480, 640, 3) * 255).astype(np.uint8)
        t = time.time()
        dets = detect(frame, args.threshold, pad_x=args.pad_x, pad_y=args.pad_y)
        print(f"[selftest] forward pass OK in {(time.time()-t)*1000:.1f} ms, "
              f"{len(dets)} detections >= {args.threshold} on a noise frame.")
        return

    cap = cv2.VideoCapture(args.camera)
    if not cap.isOpened():
        raise SystemExit(f"Cannot open camera {args.camera}")
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        t = time.time()
        dets = smooth(detect(frame, args.threshold, pad_x=args.pad_x, pad_y=args.pad_y))
        draw(frame, dets)
        fps = 1.0 / max(time.time() - t, 1e-6)
        cv2.putText(frame, f"BlazeFace INT8  {fps:5.1f} FPS  faces:{len(dets)}",
                    (10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 0), 2)
        cv2.imshow("BlazeFace INT8 (q to quit)", frame)
        if cv2.waitKey(1) & 0xFF == ord("q"):
            break
    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
