FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV ELAN_HOME=/opt/elan
ENV PATH=/opt/elan/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    coq \
    xz-utils \
    zstd \
  && rm -rf /var/lib/apt/lists/*

RUN curl -sSf https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh \
    | sh -s -- -y --default-toolchain leanprover/lean4:stable --no-modify-path

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV LEAN_CMD=lean
ENV COQ_CMD=coqc
ENV LEAN_LAMBDA_CMD=node
ENV LEAN_LAMBDA_ARGS="tools/convert-lean.cjs --out {out}"
ENV COQ_LAMBDA_CMD=node
ENV COQ_LAMBDA_ARGS="tools/convert-coq.cjs --out {out}"

EXPOSE 3000

CMD ["npm", "start"]