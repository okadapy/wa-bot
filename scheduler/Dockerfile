FROM ubuntu:latest
LABEL authors="OKADA"

FROM golang:1.22.2-alpine
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 COOS=linux go build -o /main .

EXPOSE 80
CMD ["./main"]
