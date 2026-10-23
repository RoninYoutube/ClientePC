// Sidecar local que abre la conexion WSS real hacia el servidor de Galaxy
// usando un ClientHello TLS clonado de Chrome (via uTLS), para que el
// fingerprint JA3/JA4 de la capa TLS coincida con el de un navegador real.
// El cliente Electron/Node habla WS plano contra este proceso en
// 127.0.0.1 y no necesita saber nada de uTLS: la relacion de mensajes es
// 1:1, este proceso solo hace de puente (bridge) frame por frame.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	utls "github.com/refraction-networking/utls"
)

// Headers de aplicacion que manda el cliente web real (galaxy.mobstudio.ru).
// Deben coincidir con WS_HANDSHAKE_HEADERS en src/galaxy-client.js; si ese
// archivo cambia, hay que actualizar esto a mano tambien (no hay una unica
// fuente de verdad compartida entre Node y Go).
var defaultHeaders = map[string]string{
	"Origin":          "https://galaxy.mobstudio.ru",
	"User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
	"Accept-Encoding": "gzip, deflate, br, zstd",
	"Accept-Language": "es-ES,es;q=0.9",
	"Cache-Control":   "no-cache",
	"Pragma":          "no-cache",
	"Sec-GPC":         "1",
}

// Debe coincidir con WS_URL en src/galaxy-client.js.
const defaultTargetURL = "wss://cs.mobstudio.ru:6672/"

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	// Solo escuchamos en 127.0.0.1; el unico cliente posible es nuestra
	// propia app Electron, no hace falta validar Origin.
	CheckOrigin: func(r *http.Request) bool { return true },
}

type proxyConfig struct {
	host string
	port string
	user string
	pass string
}

func parseProxyFromQuery(q url.Values) *proxyConfig {
	host := strings.TrimSpace(q.Get("proxyHost"))
	port := strings.TrimSpace(q.Get("proxyPort"))
	if host == "" || port == "" {
		return nil
	}
	return &proxyConfig{
		host: host,
		port: port,
		user: q.Get("proxyUser"),
		pass: q.Get("proxyPass"),
	}
}

func parseHeadersFromQuery(q url.Values) map[string]string {
	raw := strings.TrimSpace(q.Get("headers"))
	if raw == "" {
		return nil
	}
	var headers map[string]string
	if err := json.Unmarshal([]byte(raw), &headers); err != nil {
		log.Printf("[local] headers JSON invalido, usando defaults: %v", err)
		return nil
	}
	return headers
}

// prefixedConn antepone bytes ya leidos (y no consumidos) del handshake del
// proxy a las lecturas subsiguientes. Equivalente a socket.unshift() en
// Node (ver connectHttpProxyTunnel en proxy.js): el proxy puede mandar el
// 200 de la respuesta CONNECT pegado con el primer byte del handshake TLS
// en el mismo paquete TCP, y esos bytes extra no se pueden perder.
type prefixedConn struct {
	net.Conn
	leftover []byte
}

func (c *prefixedConn) Read(p []byte) (int, error) {
	if len(c.leftover) > 0 {
		n := copy(p, c.leftover)
		c.leftover = c.leftover[n:]
		return n, nil
	}
	return c.Conn.Read(p)
}

// connectThroughProxy replica connectHttpProxyTunnel de proxy.js: abre TCP
// contra el proxy, manda CONNECT, y devuelve el socket crudo tunelizado
// hacia targetAddr una vez que el proxy respondio 200.
func connectThroughProxy(ctx context.Context, proxy *proxyConfig, targetAddr string) (net.Conn, error) {
	d := net.Dialer{Timeout: 15 * time.Second}
	proxyAddr := net.JoinHostPort(proxy.host, proxy.port)
	conn, err := d.DialContext(ctx, "tcp", proxyAddr)
	if err != nil {
		return nil, fmt.Errorf("no se pudo conectar al proxy %s: %w", proxyAddr, err)
	}

	reqLines := []string{
		fmt.Sprintf("CONNECT %s HTTP/1.1", targetAddr),
		fmt.Sprintf("Host: %s", targetAddr),
		"Connection: Keep-Alive",
		"Proxy-Connection: Keep-Alive",
	}
	if proxy.user != "" || proxy.pass != "" {
		auth := base64.StdEncoding.EncodeToString([]byte(proxy.user + ":" + proxy.pass))
		reqLines = append(reqLines, "Proxy-Authorization: Basic "+auth)
	}

	if _, err := conn.Write([]byte(strings.Join(reqLines, "\r\n") + "\r\n\r\n")); err != nil {
		conn.Close()
		return nil, fmt.Errorf("error escribiendo CONNECT: %w", err)
	}

	conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	var buf []byte
	tmp := make([]byte, 4096)
	headerEnd := -1
	for headerEnd == -1 {
		n, err := conn.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
			headerEnd = bytes.Index(buf, []byte("\r\n\r\n"))
		}
		if err != nil {
			conn.Close()
			return nil, fmt.Errorf("error leyendo respuesta del proxy: %w", err)
		}
	}
	conn.SetReadDeadline(time.Time{})

	header := string(buf[:headerEnd])
	leftover := buf[headerEnd+4:]
	firstLine := strings.SplitN(header, "\r\n", 2)[0]
	if !strings.Contains(firstLine, " 200 ") {
		conn.Close()
		return nil, fmt.Errorf("proxy rechazo CONNECT %s (%s)", targetAddr, strings.TrimSpace(firstLine))
	}

	return &prefixedConn{Conn: conn, leftover: leftover}, nil
}

// dialUTLS abre la conexion (directa o via proxy) y hace el handshake TLS
// con un ClientHello clonado de Chrome (uTLS) en vez del ClientHello nativo
// de Go, que de otra forma delataria el binario como trafico no-navegador.
//
// Se conecta como NetDialTLSContext del Dialer de gorilla/websocket en vez
// de usar el campo Proxy nativo de gorilla a proposito: gorilla tiene un
// bug conocido (issue #779) cuando se combinan Proxy + NetDialTLSContext,
// asi que el tunel CONNECT se maneja entero aca adentro.
func dialUTLS(ctx context.Context, network, addr string, proxy *proxyConfig) (net.Conn, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, fmt.Errorf("direccion invalida %q: %w", addr, err)
	}

	var rawConn net.Conn
	if proxy != nil {
		rawConn, err = connectThroughProxy(ctx, proxy, addr)
	} else {
		d := net.Dialer{Timeout: 15 * time.Second}
		rawConn, err = d.DialContext(ctx, network, addr)
	}
	if err != nil {
		return nil, err
	}

	uConn := utls.UClient(rawConn, &utls.Config{ServerName: host}, utls.HelloChrome_Auto)
	rawConn.SetDeadline(time.Now().Add(15 * time.Second))
	if err := uConn.Handshake(); err != nil {
		rawConn.Close()
		return nil, fmt.Errorf("handshake TLS (uTLS) fallo: %w", err)
	}
	rawConn.SetDeadline(time.Time{})
	return uConn, nil
}

// pipe relee mensajes de src y los reescribe en dst preservando el tipo de
// frame (texto/binario) tal cual, sin reinterpretar el contenido.
func pipe(src, dst *websocket.Conn, done chan<- error) {
	for {
		mt, data, err := src.ReadMessage()
		if err != nil {
			done <- err
			return
		}
		if err := dst.WriteMessage(mt, data); err != nil {
			done <- err
			return
		}
	}
}

func bridgeHandler(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	targetURL := strings.TrimSpace(q.Get("target"))
	if targetURL == "" {
		targetURL = defaultTargetURL
	}
	proxy := parseProxyFromQuery(q)
	headerOverrides := parseHeadersFromQuery(q)

	localConn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[local] error en upgrade: %v", err)
		return
	}
	defer localConn.Close()

	headers := http.Header{}
	for k, v := range defaultHeaders {
		headers.Set(k, v)
	}
	for k, v := range headerOverrides {
		headers.Set(k, v)
	}

	dialer := &websocket.Dialer{
		NetDialTLSContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			return dialUTLS(ctx, network, addr, proxy)
		},
		HandshakeTimeout:  15 * time.Second,
		EnableCompression: true,
	}

	remoteConn, resp, err := dialer.Dial(targetURL, headers)
	if err != nil {
		status := ""
		if resp != nil {
			status = resp.Status
		}
		log.Printf("[remote] error conectando a %s: %v %s", targetURL, err, status)
		localConn.WriteMessage(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(1011, fmt.Sprintf("upstream dial failed: %v", err)),
		)
		return
	}
	defer remoteConn.Close()

	log.Printf("[bridge] conectado -> %s (proxy=%v)", targetURL, proxy != nil)

	done := make(chan error, 2)
	go pipe(localConn, remoteConn, done)
	go pipe(remoteConn, localConn, done)
	<-done
	log.Printf("[bridge] sesion cerrada -> %s", targetURL)
}

// dialUTLSForHTTP abre una conexion TCP+uTLS hacia host:port (optionalmente via
// proxy HTTP CONNECT) lista para ser usada como transporte de peticiones HTTP/1.1.
func dialUTLSForHTTP(ctx context.Context, host, port string, proxy *proxyConfig) (net.Conn, error) {
	addr := net.JoinHostPort(host, port)
	var rawConn net.Conn
	var err error
	if proxy != nil {
		rawConn, err = connectThroughProxy(ctx, proxy, addr)
	} else {
		d := net.Dialer{Timeout: 15 * time.Second}
		rawConn, err = d.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return nil, err
	}
	spec, err := chromeHTTP11Spec()
	if err != nil {
		rawConn.Close()
		return nil, err
	}

	uConn := utls.UClient(rawConn, &utls.Config{ServerName: host}, utls.HelloCustom)
	if err := uConn.ApplyPreset(spec); err != nil {
		rawConn.Close()
		return nil, fmt.Errorf("preset TLS HTTP/1.1 fallo: %w", err)
	}
	rawConn.SetDeadline(time.Now().Add(15 * time.Second))
	if err := uConn.Handshake(); err != nil {
		rawConn.Close()
		return nil, fmt.Errorf("handshake TLS (uTLS/http) fallo: %w", err)
	}
	rawConn.SetDeadline(time.Time{})
	return uConn, nil
}

// httpProxyHandler recibe peticiones HTTP del cliente Node y las reenvía al
// destino usando uTLS (mismo fingerprint Chrome que el bridge WS). Parametros
// esperados como JSON en el body del POST:
//
//	{ "method": "GET",
//	  "url": "https://...",
//	  "headers": { "Header-Name": "value" },
//	  "body": "<base64 del cuerpo>"  // vacío string si no hay body
//	  "proxyHost": "...", "proxyPort": "...",
//	  "proxyUser": "...", "proxyPass": "..."  // opcionales
//	}
//
// La respuesta es JSON:
//
//	{ "statusCode": 200,
//	  "headers": { "Content-Type": [...] },
//	  "body": "<base64>" }
func chromeHTTP11Spec() (*utls.ClientHelloSpec, error) {
	spec, err := utls.UTLSIdToSpec(utls.HelloChrome_Auto)
	if err != nil {
		return nil, fmt.Errorf("preset Chrome no disponible: %w", err)
	}

	extensions := make([]utls.TLSExtension, 0, len(spec.Extensions))
	for _, ext := range spec.Extensions {
		switch e := ext.(type) {
		case *utls.ALPNExtension:
			e.AlpnProtocols = []string{"http/1.1"}
			extensions = append(extensions, e)
		case *utls.ApplicationSettingsExtension, *utls.ApplicationSettingsExtensionNew:
			continue
		default:
			extensions = append(extensions, ext)
		}
	}
	spec.Extensions = extensions
	return &spec, nil
}

func writeProxyError(w http.ResponseWriter, statusCode int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"statusCode": statusCode,
		"headers":    map[string][]string{},
		"body":       base64.StdEncoding.EncodeToString([]byte(message)),
		"error":      message,
	})
}

func httpProxyHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeProxyError(w, http.StatusMethodNotAllowed, "se requiere POST")
		return
	}

	type inRequest struct {
		Method    string            `json:"method"`
		URL       string            `json:"url"`
		Headers   map[string]string `json:"headers"`
		Body      string            `json:"body"`
		ProxyHost string            `json:"proxyHost"`
		ProxyPort string            `json:"proxyPort"`
		ProxyUser string            `json:"proxyUser"`
		ProxyPass string            `json:"proxyPass"`
	}

	var req inRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeProxyError(w, http.StatusBadRequest, fmt.Sprintf("JSON invalido: %v", err))
		return
	}

	parsedURL, err := url.Parse(req.URL)
	if err != nil || (parsedURL.Scheme != "https" && parsedURL.Scheme != "http") {
		writeProxyError(w, http.StatusBadRequest, "URL invalida o esquema no soportado")
		return
	}

	host := parsedURL.Hostname()
	port := parsedURL.Port()
	if port == "" {
		if parsedURL.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}

	var proxy *proxyConfig
	if req.ProxyHost != "" && req.ProxyPort != "" {
		proxy = &proxyConfig{
			host: req.ProxyHost,
			port: req.ProxyPort,
			user: req.ProxyUser,
			pass: req.ProxyPass,
		}
	}

	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	var conn net.Conn
	if parsedURL.Scheme == "https" {
		conn, err = dialUTLSForHTTP(ctx, host, port, proxy)
	} else {
		if proxy != nil {
			conn, err = connectThroughProxy(ctx, proxy, net.JoinHostPort(host, port))
		} else {
			d := net.Dialer{Timeout: 15 * time.Second}
			conn, err = d.DialContext(ctx, "tcp", net.JoinHostPort(host, port))
		}
	}
	if err != nil {
		writeProxyError(w, http.StatusBadGateway, fmt.Sprintf("error de conexion: %v", err))
		return
	}
	defer conn.Close()

	var bodyBytes []byte
	if req.Body != "" {
		bodyBytes, err = base64.StdEncoding.DecodeString(req.Body)
		if err != nil {
			writeProxyError(w, http.StatusBadRequest, "body base64 invalido")
			return
		}
	}

	pathQuery := parsedURL.RequestURI()
	var bodyReader io.Reader
	if len(bodyBytes) > 0 {
		bodyReader = bytes.NewReader(bodyBytes)
	} else {
		bodyReader = http.NoBody
	}
	httpReq, err := http.NewRequestWithContext(ctx, req.Method, "", bodyReader)
	if err != nil {
		writeProxyError(w, http.StatusInternalServerError, fmt.Sprintf("error construyendo request: %v", err))
		return
	}
	httpReq.URL = parsedURL
	httpReq.RequestURI = pathQuery
	httpReq.Host = host
	// Connection: close para que el servidor senale EOF cerrando el socket;
	// sin esto, si la respuesta no trae Content-Length ni chunked encoding,
	// io.ReadAll se quedaría esperando indefinidamente.
	httpReq.Close = true
	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}
	if len(bodyBytes) > 0 && httpReq.Header.Get("Content-Length") == "" {
		httpReq.ContentLength = int64(len(bodyBytes))
	}

	// Escribir HTTP/1.1 crudo sobre el conn uTLS
	if err := httpReq.Write(conn); err != nil {
		writeProxyError(w, http.StatusBadGateway, fmt.Sprintf("error enviando request: %v", err))
		return
	}

	// El deadline cubre tanto los headers (ReadResponse) como el body
	// completo (io.ReadAll): se borra solo al terminar de leer todo.
	conn.SetDeadline(time.Now().Add(20 * time.Second))
	resp, err := http.ReadResponse(newBufReader(conn), httpReq)
	if err != nil {
		conn.SetDeadline(time.Time{})
		writeProxyError(w, http.StatusBadGateway, fmt.Sprintf("error leyendo respuesta: %v", err))
		return
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	conn.SetDeadline(time.Time{})
	if err != nil {
		writeProxyError(w, http.StatusBadGateway, fmt.Sprintf("error leyendo body: %v", err))
		return
	}

	respHeaders := make(map[string][]string)
	for k, vs := range resp.Header {
		respHeaders[k] = vs
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"statusCode": resp.StatusCode,
		"headers":    respHeaders,
		"body":       base64.StdEncoding.EncodeToString(respBody),
	})
}

// newBufReader envuelve un net.Conn en un bufio.Reader para http.ReadResponse.
func newBufReader(conn net.Conn) *bufio.Reader {
	return bufio.NewReader(conn)
}

func main() {
	port := flag.Int("port", 8791, "puerto local donde escucha el sidecar (127.0.0.1)")
	flag.Parse()

	mux := http.NewServeMux()
	mux.HandleFunc("/bridge", bridgeHandler)
	mux.HandleFunc("/http", httpProxyHandler)

	addr := fmt.Sprintf("127.0.0.1:%d", *port)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("no se pudo escuchar en %s: %v", addr, err)
	}

	server := &http.Server{Handler: mux}

	go func() {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			log.Fatalf("error del servidor: %v", err)
		}
	}()

	// Le avisa a quien lo haya lanzado (main.js) que ya esta listo para
	// aceptar conexiones. main.js debe leer esta linea de stdout antes de
	// permitir connect() desde la UI.
	fmt.Printf("LISTENING %d\n", *port)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	<-sigCh

	log.Println("[sidecar] apagando...")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	server.Shutdown(ctx)
}
