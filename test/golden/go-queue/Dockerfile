FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY main.go ops.go ./
COPY arcodio ./arcodio
RUN CGO_ENABLED=0 go build -trimpath -o /out/service .

FROM alpine:3.20
WORKDIR /app
COPY --from=build /out/service /app/service
ENV PORT=3000
EXPOSE 3000
CMD ["/app/service"]
