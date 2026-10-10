# Local analysis tool only; nothing in this image is shipped in the app.
# soxr / libsndfile (LGPL) and certifi (MPL-2.0) come in via librosa/soundfile: local-tool-only, never to be shipped in the app (R12).
# Base image pinned by digest (R11); tag kept for readability.
FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONDONTWRITEBYTECODE=1
# requirements.lock.txt = `pip freeze` of this image built from requirements.txt (direct deps) - all transitive deps pinned.
COPY requirements.lock.txt /tmp/requirements.lock.txt
RUN pip install --no-cache-dir -r /tmp/requirements.lock.txt && rm /tmp/requirements.lock.txt
