FROM node:22-bookworm AS frontend
WORKDIR /app
COPY package*.json ./
RUN npm install --legacy-peer-deps
COPY . .
RUN npm run build

FROM python:3.12-slim AS backend
WORKDIR /app
# /app so specter_exec resolves: the engine is shared with the host shim and is
# deliberately not inside backend/, which does not own it.
ENV PYTHONPATH=/app/backend:/app
COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir -r /app/backend/requirements.txt
COPY backend /app/backend
COPY specter_exec /app/specter_exec
COPY --from=frontend /app/dist /app/frontend
RUN mkdir -p /app/data /app/artifacts /app/secrets /app/codebases
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--app-dir", "/app/backend"]
