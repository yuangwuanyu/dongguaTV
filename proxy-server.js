const http = require('http');
const https = require('https');
const url = require('url');

// 配置
const PORT = process.env.PORT || 8080;
const ACCESS_PASSWORD = process.env.PROXY_PASSWORD || ''; // 可选：设置访问密码

// CORS 响应头
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, HEAD',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
    'Access-Control-Max-Age': '86400',
};

// 需要排除的响应头
const EXCLUDE_HEADERS = new Set([
    'access-control-allow-origin',
    'access-control-allow-methods',
    'access-control-allow-headers',
    'access-control-expose-headers',
    'access-control-max-age',
    'access-control-allow-credentials',
    'content-encoding',
    'transfer-encoding',
    'connection',
    'keep-alive',
    'host'
]);

const server = http.createServer(async (req, res) => {
    // 1. 处理 CORS 预检请求
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
    }

    const reqUrl = new URL(req.url, `http://${req.headers.host}`);

    // 2. 健康检查
    if (reqUrl.pathname === '/health') {
        res.writeHead(200, CORS_HEADERS);
        res.end('OK');
        return;
    }

    // 3. 获取目标 URL
    const targetUrlParam = reqUrl.searchParams.get('url');
    if (!targetUrlParam) {
        // 返回帮助页面
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS });
        res.end(getHelpPage(`http://${req.headers.host}`));
        return;
    }

    // 4. 验证密码（如果设置了）
    if (ACCESS_PASSWORD) {
        const auth = req.headers['authorization'];
        if (!auth || auth !== `Bearer ${ACCESS_PASSWORD}`) {
            res.writeHead(403, CORS_HEADERS);
            res.end('Unauthorized');
            return;
        }
    }

    try {
        const targetURL = new URL(targetUrlParam);

        // 5. 构建代理请求
        const proxyOptions = {
            method: req.method,
            headers: {},
            timeout: 20000 // 20秒超时
        };

        // 伪装请求头
        proxyOptions.headers['Referer'] = targetURL.origin + '/';
        proxyOptions.headers['Origin'] = targetURL.origin;
        proxyOptions.headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

        // 复制必要的请求头
        ['range', 'accept', 'accept-language'].forEach(h => {
            if (req.headers[h]) proxyOptions.headers[h] = req.headers[h];
        });
        if (!proxyOptions.headers['Accept']) proxyOptions.headers['Accept'] = '*/*';

        // 发起请求
        const protocol = targetURL.protocol === 'https:' ? https : http;

        const proxyReq = protocol.request(targetURL, proxyOptions, (proxyRes) => {
            // 6. 处理响应
            const responseHeaders = { ...CORS_HEADERS };

            // 复制目标响应头
            Object.keys(proxyRes.headers).forEach(key => {
                if (!EXCLUDE_HEADERS.has(key.toLowerCase())) {
                    responseHeaders[key] = proxyRes.headers[key];
                }
            });

            // 7. 处理 m3u8 重写
            const contentType = proxyRes.headers['content-type'] || '';
            const isM3u8 = targetURL.pathname.endsWith('.m3u8') ||
                contentType.includes('mpegurl') ||
                contentType.includes('x-mpegurl');

            if (isM3u8 && proxyRes.statusCode === 200) {
                let chunks = [];
                proxyRes.on('data', chunk => chunks.push(chunk));
                proxyRes.on('end', () => {
                    try {
                        const buffer = Buffer.concat(chunks);
                        const content = buffer.toString('utf8');
                        const currentOrigin = `http://${req.headers.host}`;
                        const rewritten = rewriteM3u8(content, targetURL, currentOrigin);

                        responseHeaders['Content-Type'] = 'application/vnd.apple.mpegurl';
                        delete responseHeaders['content-length'];

                        res.writeHead(proxyRes.statusCode, responseHeaders);
                        res.end(rewritten);
                    } catch (e) {
                        console.error('M3U8 Rewrite Error:', e);
                        res.writeHead(502, CORS_HEADERS);
                        res.end('Proxy M3U8 Error');
                    }
                });
            } else {
                // 直接透传非 m3u8 内容
                res.writeHead(proxyRes.statusCode, responseHeaders);
                proxyRes.pipe(res);
            }
        });

        proxyReq.on('error', (err) => {
            console.error('Proxy Request Error:', err.message);
            if (!res.headersSent) {
                res.writeHead(502, CORS_HEADERS);
                res.end('Proxy Error: ' + err.message);
            }
        });

        // 转发请求体（如果有）
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            req.pipe(proxyReq);
        } else {
            proxyReq.end();
        }

    } catch (err) {
        if (!res.headersSent) {
            res.writeHead(400, CORS_HEADERS);
            res.end('Invalid URL');
        }
    }
});

/**
 * m3u8 重写逻辑（与 Workers 版本一致）
 */
function rewriteM3u8(content, baseUrl, proxyOrigin) {
    const lines = content.split('\n');
    const baseOrigin = baseUrl.origin;
    const basePath = baseUrl.pathname.substring(0, baseUrl.pathname.lastIndexOf('/') + 1);

    return lines.map(line => {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('#') || trimmedLine === '') {
            if (trimmedLine.includes('URI="')) {
                return line.replace(/URI="([^"]+)"/g, (match, uri) => {
                    const absoluteUrl = resolveUrl(uri, baseOrigin, basePath);
                    return `URI="${proxyOrigin}/?url=${encodeURIComponent(absoluteUrl)}"`;
                });
            }
            return line;
        }
        const absoluteUrl = resolveUrl(trimmedLine, baseOrigin, basePath);
        return `${proxyOrigin}/?url=${encodeURIComponent(absoluteUrl)}`;
    }).join('\n');
}

function resolveUrl(url, baseOrigin, basePath) {
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    if (url.startsWith('//')) return 'https:' + url;
    if (url.startsWith('/')) return baseOrigin + url;
    return baseOrigin + basePath + url;
}

function getHelpPage(origin) {
    return `<h1>CORS Proxy Server</h1><p>Running on Node.js</p><pre>${origin}/?url=https://example.com/video.m3u8</pre>`;
}

server.listen(PORT, () => {
    console.log(`CORS Proxy Server running on port ${PORT}`);
});
