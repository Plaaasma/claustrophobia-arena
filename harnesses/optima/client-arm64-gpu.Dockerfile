# GPU build for the DGX Spark (GB10, aarch64): links the Rust client against
# the TensorFlow C API inside NVIDIA's NGC TF2 container — NVIDIA already built
# TF 2.17 for arm64 + Blackwell, so no bazel source build is needed. The GB10
# shows as compute capability 12.1 and works despite the image's version
# warning (verified: device created, matmul on GPU).
#
#   docker build -f docker/client-arm64-gpu.Dockerfile -t optima-ishtar:arm64-gpu-v1 .
#   docker run -i --rm --gpus all optima-ishtar:arm64-gpu-v1   # UGI on stdio
FROM nvcr.io/nvidia/tensorflow:25.02-tf2-py3 AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl pkg-config libssl-dev zlib1g-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# expose the image's TF C API the way the tensorflow-sys crate expects
RUN cd /usr/local/lib/tensorflow \
    && ln -sf libtensorflow_cc.so.2 libtensorflow.so.2 \
    && ln -sf libtensorflow.so.2 libtensorflow.so \
    && ln -sf /usr/local/lib/python3.12/dist-packages/tensorflow/libtensorflow_framework.so.2 libtensorflow_framework.so.2 \
    && ln -sf libtensorflow_framework.so.2 libtensorflow_framework.so \
    && mkdir -p /usr/local/lib/pkgconfig \
    && printf 'prefix=/usr/local\nlibdir=/usr/local/lib/tensorflow\nincludedir=${prefix}/include\n\nName: TensorFlow\nVersion: 2.17.0\nDescription: TensorFlow C API (NGC arm64 GPU build)\nLibs: -L${libdir} -ltensorflow -ltensorflow_framework\nCflags: -I${includedir}\n' > /usr/local/lib/pkgconfig/tensorflow.pc \
    && ldconfig

RUN curl -fsSL https://sh.rustup.rs -o /tmp/rustup-init.sh \
    && sh /tmp/rustup-init.sh -y --default-toolchain stable \
    && rm /tmp/rustup-init.sh
ENV PATH="/root/.cargo/bin:${PATH}"
ENV PKG_CONFIG_PATH=/usr/local/lib/pkgconfig
ENV LD_LIBRARY_PATH=/usr/local/lib/tensorflow:${LD_LIBRARY_PATH}

WORKDIR /build
COPY . .

RUN cargo build --release -p client

# runtime: same NGC image — brings the whole CUDA/cuDNN/TF runtime closure
FROM nvcr.io/nvidia/tensorflow:25.02-tf2-py3

RUN cd /usr/local/lib/tensorflow \
    && ln -sf libtensorflow_cc.so.2 libtensorflow.so.2 \
    && ln -sf /usr/local/lib/python3.12/dist-packages/tensorflow/libtensorflow_framework.so.2 libtensorflow_framework.so.2 \
    && ldconfig

WORKDIR /app
COPY --from=builder /build/target/release/client ./client

ARG MODEL_FILE=model.tar.gz
COPY docker/${MODEL_FILE} ./${MODEL_FILE}

ENV LD_LIBRARY_PATH=/usr/local/lib/tensorflow:${LD_LIBRARY_PATH}
ENV TF_CPP_MIN_LOG_LEVEL=2
ENV TF_FORCE_GPU_ALLOW_GROWTH=true
ENV BOT_MODEL_DIR=/app
ENV BOT_MODEL_NAME=${MODEL_FILE}

ENTRYPOINT ["./client"]
CMD ["ugi"]
