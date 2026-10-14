const net = require("node:net");
function t(host, port) {
  return new Promise((res) => {
    const s = net.connect(port, host, () => {
      console.log(`${host}:${port} OK`);
      s.end();
      res(true);
    });
    s.on("error", (e) => {
      console.log(`${host}:${port} ERR ${e.message}`);
      res(false);
    });
  });
}
(async () => {
  await t("127.0.0.1", 9222);
  await t("localhost", 9222);
  await t("::1", 9222);
})();
