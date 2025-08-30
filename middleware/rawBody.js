// сохраняем исходный raw body в req.rawBody (для HMAC-подписи)
module.exports = function rawBody(req, res, next) {
  let data = [];
  req.on('data', chunk => data.push(chunk));
  req.on('end', () => { req.rawBody = Buffer.concat(data).toString('utf8'); next(); });
};
