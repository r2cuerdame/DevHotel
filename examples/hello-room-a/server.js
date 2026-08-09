const http = require('http')

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html>
<html>
  <head><title>Room A</title></head>
  <body style="font-family: system-ui; background:#1a2b3c; color:#eee; display:flex; align-items:center; justify-content:center; height:100vh; margin:0">
    <div style="text-align:center">
      <h1 style="color:#7fd0ff">Hello from Room A</h1>
      <p>internal port 3000 · pid ${process.pid}</p>
      <p>node ${process.version}</p>
      <p>counter: <span id="c">0</span></p>
      <script>
        let n = Number(localStorage.getItem('count') || 0) + 1
        localStorage.setItem('count', n)
        document.getElementById('c').textContent = n
      </script>
    </div>
  </body>
</html>`)
})

server.listen(3000, () => console.log('room-a listening on 3000'))
