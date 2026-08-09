const http = require('http')

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html>
<html>
  <head><title>Room B</title></head>
  <body style="font-family: system-ui; background:#3c2b1a; color:#eee; display:flex; align-items:center; justify-content:center; height:100vh; margin:0">
    <div style="text-align:center">
      <h1 style="color:#ffd07f">Hello from Room B</h1>
      <p>internal port 3000 · pid ${process.pid}</p>
      <p>node ${process.version}</p>
    </div>
  </body>
</html>`)
})

server.listen(3000, () => console.log('room-b listening on 3000'))
