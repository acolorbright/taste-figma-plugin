FROM python:3.12-slim
WORKDIR /app
COPY server/requirements.txt /app/server/requirements.txt
RUN pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu -r server/requirements.txt
COPY server /app/server
RUN useradd --create-home app && mkdir -p /home/app/.cache && chown -R app:app /home/app /app
USER app
ENV TASTE_LIBRARY_PATH=/library
EXPOSE 8765
CMD ["python", "-m", "server.run", "--host", "0.0.0.0"]
