# Lean 4 toolchain and checker. Nothing is installed on the host.
#
#   docker build -t guard-lean lean/                       # full image, entrypoint runs the checker
#   docker build --target toolchain -t guard-lean-toolchain lean/
#   docker run --rm -v "$PWD/lean:/guard" guard-lean-toolchain lake build   # iterate on sources
#   echo '{"classes":["card"],"inputs":[{"kind":"root","children":[]}]}' | docker run -i --rm guard-lean

FROM ubuntu:24.04 AS toolchain
RUN apt-get update && apt-get install -y --no-install-recommends curl git ca-certificates build-essential \
  && rm -rf /var/lib/apt/lists/*
ENV ELAN_HOME=/opt/elan PATH=/opt/elan/bin:$PATH
RUN curl -sSfL -o /tmp/elan-init.sh https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh \
  && sh /tmp/elan-init.sh -y --default-toolchain none --no-modify-path \
  && rm /tmp/elan-init.sh
WORKDIR /guard
COPY lean-toolchain lakefile.toml ./
# Installs the pinned toolchain named in lean-toolchain and caches it as a layer.
RUN elan toolchain install "$(cat lean-toolchain)" && lean --version

FROM toolchain AS build
COPY . .
RUN lake build

FROM build AS checker
ENTRYPOINT ["/guard/.lake/build/bin/guard"]

# Optional: #guard unit checks and the guard-tests executable.
#   docker build --target test lean/
FROM build AS test
RUN lake build Tests guard-tests && lake exe guard-tests

# --- WebAssembly build ------------------------------------------------------
# Uses the last Lean release that shipped a prebuilt wasm32 runtime (v4.15.0;
# later releases do not publish one) plus a pinned Emscripten SDK.
#   docker build --target wasm -t guard-lean-wasm lean/
#   docker run --rm -v "$PWD/lean/wasm/dist:/guard/wasm/dist" guard-lean-wasm
FROM toolchain AS wasm-tools
ARG LEAN_VERSION=4.15.0
ARG EMSDK_VERSION=3.1.64
RUN apt-get update && apt-get install -y --no-install-recommends python3 zstd xz-utils bzip2 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 https://github.com/emscripten-core/emsdk.git /opt/emsdk \
  && /opt/emsdk/emsdk install ${EMSDK_VERSION} && /opt/emsdk/emsdk activate ${EMSDK_VERSION}
RUN curl -sSfL -o /tmp/lean-wasm.tar.zst \
     https://github.com/leanprover/lean4/releases/download/v${LEAN_VERSION}/lean-${LEAN_VERSION}-linux_wasm32.tar.zst \
  && mkdir -p /opt/lean-wasm && tar --zstd -xf /tmp/lean-wasm.tar.zst -C /opt/lean-wasm --strip-components=1 \
  && rm /tmp/lean-wasm.tar.zst && ls /opt/lean-wasm/lib/lean
ENV LEAN_WASM=/opt/lean-wasm

# Sources are copied last so that editing Lean code does not rebuild the SDK layers.
FROM wasm-tools AS wasm
COPY . .
RUN lake build Guard
ENTRYPOINT ["/bin/bash", "-lc", "source /opt/emsdk/emsdk_env.sh >/dev/null 2>&1 && ./wasm/build.sh"]
