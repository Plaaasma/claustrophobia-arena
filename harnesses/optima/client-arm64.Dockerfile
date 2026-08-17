# aarch64 (GB10) adaptation of docker/client.Dockerfile: upstream pins the
# x86_64-only tensorflow:2.8.0-gpu base + libtensorflow download. This build is
# CPU inference, with the TF C API taken from the official aarch64 python wheel
# (its libtensorflow_cc.so.2 exports the C API; libomp is the wheel's vendored
# OpenMP runtime that libtensorflow_cc links against).
#
#   docker build -f docker/client-arm64.Dockerfile -t optima-ishtar:arm64-v1 .
#   docker run -i --rm optima-ishtar:arm64-v1     # speaks UGI on stdio
FROM ubuntu:24.04 AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl build-essential pkg-config libssl-dev zlib1g-dev ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*

COPY tfwheel/ /tmp/tfwheel/
RUN cd /tmp/tfwheel \
    && unzip -q -o *.whl \
        "tensorflow/libtensorflow_cc.so.2" \
        "tensorflow/libtensorflow_framework.so.2" \
        "tensorflow.libs/libomp-6196b3b5.so.5" \
    && install -m 0755 tensorflow/libtensorflow_cc.so.2 /usr/local/lib/ \
    && install -m 0755 tensorflow/libtensorflow_framework.so.2 /usr/local/lib/ \
    && install -m 0755 tensorflow.libs/libomp-6196b3b5.so.5 /usr/local/lib/ \
    && ln -s libtensorflow_cc.so.2 /usr/local/lib/libtensorflow.so.2 \
    && ln -s libtensorflow.so.2 /usr/local/lib/libtensorflow.so \
    && ln -s libtensorflow_framework.so.2 /usr/local/lib/libtensorflow_framework.so \
    && mkdir -p /usr/local/lib/pkgconfig /usr/local/include/tensorflow \
    && printf 'prefix=/usr/local\nlibdir=${prefix}/lib\nincludedir=${prefix}/include\n\nName: TensorFlow\nVersion: 2.18.0\nDescription: TensorFlow C API\nLibs: -L${libdir} -ltensorflow -ltensorflow_framework\nCflags: -I${includedir}\n' > /usr/local/lib/pkgconfig/tensorflow.pc \
    && ldconfig && rm -rf /tmp/tfwheel

RUN curl -fsSL https://sh.rustup.rs -o /tmp/rustup-init.sh \
    && sh /tmp/rustup-init.sh -y --default-toolchain stable \
    && rm /tmp/rustup-init.sh
ENV PATH="/root/.cargo/bin:${PATH}"
ENV PKG_CONFIG_PATH=/usr/local/lib/pkgconfig

WORKDIR /build
COPY . .

RUN cargo build --release -p client

FROM ubuntu:24.04
COPY --from=builder \
    /usr/local/lib/libtensorflow_cc.so.2 \
    /usr/local/lib/libtensorflow_framework.so.2 \
    /usr/local/lib/libomp-6196b3b5.so.5 \
    /usr/local/lib/
RUN ln -s libtensorflow_cc.so.2 /usr/local/lib/libtensorflow.so.2 && ldconfig

WORKDIR /app
COPY --from=builder /build/target/release/client ./client

ARG MODEL_FILE=model.tar.gz
COPY docker/${MODEL_FILE} ./${MODEL_FILE}

ENV TF_CPP_MIN_LOG_LEVEL=2
ENV BOT_MODEL_DIR=/app
ENV BOT_MODEL_NAME=${MODEL_FILE}

ENTRYPOINT ["./client"]
CMD ["ugi"]
