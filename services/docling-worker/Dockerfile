ARG PYTHON_IMAGE=docker.io/library/python:3.12-slim@sha256:e5c9fa26ffb76e11e0f054f30dc2523a2f9693f0c36c0cf1e39b27e152d899fc
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.12.8@sha256:d1cbaeadc234fe19c0d93daabcf5e98738cd93c6d1dd4918ef6aa30735feb23a

FROM ${UV_IMAGE} AS uv

FROM ${PYTHON_IMAGE} AS dependencies
WORKDIR /build/services/docling-worker
ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_LINK_MODE=copy \
    UV_NO_PROGRESS=1
COPY services/docling-worker/pyproject.toml services/docling-worker/uv.lock ./
COPY packages/document-service-python /build/packages/document-service-python
COPY services/docling-worker/docling_service/model_artifacts.py /build/model_artifacts.py
COPY services/docling-worker/docling_service/paddle_model_artifacts.py /build/paddle_model_artifacts.py
COPY --from=uv /uv /usr/local/bin/uv
RUN env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \
      uv sync --frozen --no-dev --no-install-project \
    && find /opt/venv -type d -name __pycache__ -prune -exec rm -rf '{}' +
RUN env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \
      HF_HUB_DISABLE_TELEMETRY=1 \
      /opt/venv/bin/python /build/model_artifacts.py /opt/docling-models
RUN env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \
      /opt/venv/bin/python /build/paddle_model_artifacts.py /opt/paddle-models

FROM ${PYTHON_IMAGE} AS runner
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp/home \
    HF_HOME=/tmp/huggingface \
    HF_HUB_DISABLE_TELEMETRY=1 \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    DOCLING_ARTIFACTS_PATH=/opt/docling-models \
    PADDLE_OCR_ARTIFACTS_PATH=/opt/paddle-models \
    PADDLE_PDX_CACHE_HOME=/tmp/paddlex \
    PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True \
    STORAGE_DRIVER=s3 \
    DOCUMENT_STORAGE_ROOT=/data
WORKDIR /app
RUN rm -rf /usr/local/lib/python3.12/site-packages/* \
    && env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
      -u http_proxy -u https_proxy -u all_proxy apt-get update \
    && env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
      -u http_proxy -u https_proxy -u all_proxy \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libgl1 \
      libglib2.0-0 \
      libgomp1 \
      libxcb1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 sushua-docling \
    && useradd --system --uid 10001 --gid 10001 --home-dir /nonexistent \
      --shell /usr/sbin/nologin sushua-docling \
    && mkdir --mode=0750 /data \
    && chown 10001:10001 /data
COPY --from=dependencies /opt/venv /opt/venv
COPY --from=dependencies /opt/docling-models /opt/docling-models
COPY --from=dependencies /opt/paddle-models /opt/paddle-models
COPY --chown=10001:10001 services/docling-worker/docling_service ./docling_service
USER 10001:10001
EXPOSE 8000
CMD ["uvicorn", "docling_service.app:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
