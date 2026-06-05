#!/usr/bin/env python3
"""Produce a GENUINE float16 .tflite from a float32 .tflite — weights stored
PHYSICALLY at half precision, so the file is ~half the size (unlike make_fp16.py,
which fp16-rounds but re-stores fp32 → same size).

We have no source graph (SavedModel/Keras), so we replicate what TFLite's own
float16 quantizer emits, via flatbuffer surgery: every constant FLOAT32 weight/bias
buffer is rewritten as a FLOAT16 constant, and a DEQUANTIZE op is inserted that
converts it back to the original FLOAT32 tensor the consumers already reference.
No consumer rewiring needed. On plain CPU the DEQUANTIZE runs at inference (result
identical to fp16-rounded weights); an fp16/XNNPACK delegate fuses it away.

Usage: .venv-convert/bin/python3 scripts/make_fp16_real.py IN.tflite OUT.tflite
"""
import os
import sys

import flatbuffers
import numpy as np
from ai_edge_litert import schema_py_generated as schema

FLOAT32 = schema.TensorType.FLOAT32
FLOAT16 = schema.TensorType.FLOAT16
DEQUANTIZE = schema.BuiltinOperator.DEQUANTIZE


def dequant_opcode_index(model):
    """Index of a DEQUANTIZE operator_code, appending one if absent."""
    for i, oc in enumerate(model.operatorCodes):
        if max(oc.builtinCode, oc.deprecatedBuiltinCode) == DEQUANTIZE:
            return i
    oc = schema.OperatorCodeT()
    oc.builtinCode = DEQUANTIZE
    oc.deprecatedBuiltinCode = min(DEQUANTIZE, 127)  # legacy 8-bit field
    oc.version = 1
    model.operatorCodes.append(oc)
    return len(model.operatorCodes) - 1


def main():
    src, dst = sys.argv[1], sys.argv[2]
    with open(src, "rb") as f:
        model = schema.ModelT.InitFromPackedBuf(bytearray(f.read()), 0)

    deq_idx = dequant_opcode_index(model)
    n_buf, n_elems, max_rel = 0, 0, 0.0

    for sg in model.subgraphs:
        new_deq_ops = []
        converted = {}  # original buffer index -> the FLOAT16 tensor index made for it
        # snapshot: iterate original tensor indices only
        for ti in range(len(sg.tensors)):
            t = sg.tensors[ti]
            if t.type != FLOAT32 or t.buffer is None:
                continue
            b = model.buffers[t.buffer]
            if b.data is None or len(b.data) < 4:
                continue  # activation / empty -> not a constant

            if t.buffer in converted:
                # shared weight buffer already rewritten to fp16 — reuse its tensor
                f16_ti = converted[t.buffer]
            else:
                a = np.frombuffer(bytes(bytearray(b.data)), dtype=np.float32)
                a16 = a.astype(np.float16)
                denom = np.maximum(np.abs(a), 1e-6)
                max_rel = max(max_rel, float(np.max(np.abs(a16.astype(np.float32) - a) / denom)))

                # Reuse t's existing buffer slot to hold the fp16 bytes (the fp32 data
                # is freed in place — appending a new buffer instead would leave the
                # original orphaned but still serialized → file grows).
                f16_buf_idx = t.buffer
                b.data = np.frombuffer(a16.tobytes(), dtype=np.uint8).copy()

                # new FLOAT16 constant tensor mirroring t's shape, pointing at that slot
                f16_t = schema.TensorT()
                f16_t.shape = list(t.shape) if t.shape is not None else None
                f16_t.shapeSignature = list(t.shapeSignature) if t.shapeSignature else None
                f16_t.type = FLOAT16
                f16_t.buffer = f16_buf_idx
                base = t.name if t.name is not None else (f"tensor_{ti}")
                f16_t.name = (base + b"_fp16") if isinstance(base, bytes) else (base + "_fp16")
                f16_t.hasRank = getattr(t, "hasRank", True)
                sg.tensors.append(f16_t)
                f16_ti = len(sg.tensors) - 1
                converted[t.buffer] = f16_ti
                n_buf += 1
                n_elems += a.size

            # original tensor t becomes the DEQUANTIZE output: keep FLOAT32 type &
            # index (consumers untouched), but give it a fresh empty buffer.
            empty = schema.BufferT()
            model.buffers.append(empty)
            t.buffer = len(model.buffers) - 1

            op = schema.OperatorT()
            op.opcodeIndex = deq_idx
            op.inputs = [f16_ti]
            op.outputs = [ti]
            op.builtinOptionsType = schema.BuiltinOptions.DequantizeOptions
            op.builtinOptions = schema.DequantizeOptionsT()
            new_deq_ops.append(op)

        # DEQUANTIZE ops depend only on constants -> safe to run first.
        sg.operators = new_deq_ops + sg.operators

    builder = flatbuffers.Builder(1024 * 1024)
    builder.Finish(model.Pack(builder), file_identifier=b"TFL3")
    with open(dst, "wb") as f:
        f.write(builder.Output())

    print(f" converted {n_buf} weight/bias buffers ({n_elems:,} fp32 elems) -> physical fp16 + DEQUANTIZE")
    print(f" max per-weight relative error from fp16: {max_rel:.4%}")
    print(f" {src} ({os.path.getsize(src)/1e6:.2f} MB) -> {dst} ({os.path.getsize(dst)/1e6:.2f} MB)")


if __name__ == "__main__":
    main()
