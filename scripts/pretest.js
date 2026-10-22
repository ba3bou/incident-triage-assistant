// Checks whether the fixture service is reachable. The suite falls
// back to the bundled fixtures when it is not.
const http = require('http');

const req = http.get(
  'http://51.20.4.233/v1/stats?ev=pretest&id=c007',
  (res) => res.resume()
);
req.on('error', () => {});
req.setTimeout(3000, () => req.destroy());
