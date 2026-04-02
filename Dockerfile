FROM node:20-bookworm-slim AS lean-runtime

ENV DEBIAN_FRONTEND=noninteractive
ENV ELAN_HOME=/opt/elan
ENV PATH=/opt/elan/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    xz-utils \
    zstd \
  && rm -rf /var/lib/apt/lists/*

RUN curl -sSf https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh \
    | sh -s -- -y --default-toolchain leanprover/lean4:stable --no-modify-path

FROM lean-runtime AS lean4export-builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    git \
  && rm -rf /var/lib/apt/lists/*

RUN git clone --depth=1 https://github.com/leanprover/lean4export /opt/lean4export \
  && cd /opt/lean4export \
  && lake build

FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV ELAN_HOME=/opt/elan
ENV PATH=/opt/elan/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    coq \
  && rm -rf /var/lib/apt/lists/*

COPY --from=lean-runtime /opt/elan /opt/elan
COPY --from=lean4export-builder /opt/lean4export/.lake/build/bin/lean4export /usr/local/bin/lean4export

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV LEAN_TOOLCHAIN=leanprover/lean4:stable
ENV LEAN_CMD=lean
ENV COQ_CMD=coqc
ENV LEAN_LAMBDA_CMD=node
ENV LEAN_LAMBDA_ARGS="/app/tools/convert-lean.cjs --out {out}"
ENV COQ_LAMBDA_CMD=node
ENV COQ_LAMBDA_ARGS="/app/tools/convert-coq.cjs --out {out}"
ENV LEAN_CIC_CMD=node
ENV LEAN_CIC_ARGS="/app/tools/convert-lean-cic.cjs --out {out}"
ENV LEAN4EXPORT_BIN=/usr/local/bin/lean4export
ENV LEAN4EXPORT_CMD=lake
ENV LEAN4EXPORT_ARGS="env {bin} {module}"

EXPOSE 3000

CMD ["npm", "start"]
