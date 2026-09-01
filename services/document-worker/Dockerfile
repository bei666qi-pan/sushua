ARG PYTHON_IMAGE=docker.io/library/python:3.13-slim@sha256:881d80734ee05dca6f7f42dcb080975652a53c7eda9ba1f03bb8da31aa6a6ec2
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.12.8@sha256:d1cbaeadc234fe19c0d93daabcf5e98738cd93c6d1dd4918ef6aa30735feb23a

FROM ${UV_IMAGE} AS uv

FROM ${PYTHON_IMAGE} AS dependencies
WORKDIR /build/services/document-worker
ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_LINK_MODE=copy \
    UV_NO_PROGRESS=1
COPY services/document-worker/pyproject.toml services/document-worker/uv.lock ./
COPY packages/document-service-python /build/packages/document-service-python
COPY --from=uv /uv /usr/local/bin/uv
RUN env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \
      uv sync --frozen --no-dev --no-install-project \
    && find /opt/venv -type d -name __pycache__ -prune -exec rm -rf '{}' +

FROM ${PYTHON_IMAGE} AS runner
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    STORAGE_DRIVER=s3 \
    DOCUMENT_STORAGE_ROOT=/data
WORKDIR /app
RUN rm -rf /usr/local/lib/python3.13/site-packages/* \
    && groupadd --system --gid 10001 sushua \
    && useradd --system --uid 10001 --gid 10001 --home-dir /nonexistent \
      --shell /usr/sbin/nologin sushua \
    && mkdir --mode=0750 /data \
    && chown 10001:10001 /data
COPY --from=dependencies /opt/venv /opt/venv
COPY --chown=10001:10001 services/document-worker/document_worker ./document_worker
USER 10001:10001
EXPOSE 8000
CMD ["uvicorn", "document_worker.app:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
