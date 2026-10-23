module galaxy-utls-sidecar

go 1.24

toolchain go1.24.4

require (
	github.com/gorilla/websocket v1.5.3
	github.com/refraction-networking/utls v1.8.2
)

require (
	github.com/andybalholm/brotli v1.0.6 // indirect
	github.com/klauspost/compress v1.17.4 // indirect
	golang.org/x/crypto v0.36.0 // indirect
	golang.org/x/sys v0.31.0 // indirect
)

replace golang.org/x/crypto => github.com/golang/crypto v0.36.0

replace golang.org/x/sys => github.com/golang/sys v0.31.0