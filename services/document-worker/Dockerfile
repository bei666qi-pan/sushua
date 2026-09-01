ARG PYTHON_IMAGE=docker.m.daocloud.io/library/python:3.11-slim@sha256:1042b61448fef4ba92d16a8c7eb4996d027568ce64792a7877fd88511e0af7c6
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.12.8@sha256:d1cbaeadc234fe19c0d93daabcf5e98738cd93c6d1dd4918ef6aa30735feb23a

FROM ${UV_IMAGE} AS uv

FROM ${PYTHON_IMAGE} AS dependencies
WORKDIR /build
ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_LINK_MODE=copy \
    UV_NO_PROGRESS=1
COPY pyproject.toml uv.lock ./
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
RUN groupadd --gid 10001 sushua \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin sushua \
    && mkdir --mode=0750 /data \
    && chown 10001:10001 /data
COPY --from=dependencies /opt/venv /opt/venv
COPY --chown=10001:10001 document_worker ./document_worker
USER 10001:10001
EXPOSE 8000
CMD ["uvicorn", "document_worker.app:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
