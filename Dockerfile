FROM ubuntu:latest
LABEL authors="OKADA"

ENTRYPOINT ["top", "-b"]

# Base image
FROM node:22-alpine

# Set working directory
WORKDIR /app

# Copy dependency files first (better layer caching)
COPY package*.json ./

# Copy application files
COPY . .

RUN npm i npm -g

# Expose application port
EXPOSE 3000

