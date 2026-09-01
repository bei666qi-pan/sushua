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
COPY --from=uv /uv /usr/local/bin/uv
RUN env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \
      uv sync --frozen --no-dev --no-install-project \
    && find /opt/venv -type d -name __pycache__ -prune -exec rm -rf '{}' +

FROM ${PYTHON_IMAGE} AS runner
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp/home \
    HF_HOME=/tmp/huggingface \
    STORAGE_DRIVER=s3 \
    DOCUMENT_STORAGE_ROOT=/data
WORKDIR /app
RUN rm -rf /usr/local/lib/python3.12/site-packages/* \
    && groupadd --system --gid 10002 sushua-docling \
    && useradd --system --uid 10002 --gid 10002 --home-dir /nonexistent \
      --shell /usr/sbin/nologin sushua-docling \
    && mkdir --mode=0750 /data \
    && chown 10002:10002 /data
COPY --from=dependencies /opt/venv /opt/venv
COPY --chown=10002:10002 services/docling-worker/docling_service ./docling_service
USER 10002:10002
EXPOSE 8000
CMD ["uvicorn", "docling_service.app:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
