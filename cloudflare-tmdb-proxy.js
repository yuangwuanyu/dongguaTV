/**
 * TMDB 反代脚本 - Cloudflare Workers
 * 
 * 部署步骤:
 * 1. 登录 Cloudflare Dashboard: https://dash.cloudflare.com/
 * 2. 选择 "Workers & Pages" -> "Create application" -> "Create Worker"
 * 3. 将此代码粘贴到编辑器中
 * 4. 点击 "Save and Deploy"
 * 5. 记录您的 Worker URL (如: https://tmdb-proxy.your-name.workers.dev)
 * 6. 在 index.html 中配置反代地址
 * 
 * 使用说明:
 * - API 请求: https://your-worker.workers.dev/api/3/...
 * - 图片请求: https://your-worker.workers.dev/t/p/w500/...
 */

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;

        // 设置 CORS 头
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        };

        // 处理 OPTIONS 预检请求
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        let targetUrl;

        // 判断请求类型
        if (path.startsWith('/api/')) {
            // API 请求 - 代理到 api.themoviedb.org
            targetUrl = 'https://api.themoviedb.org' + path.replace('/api', '') + url.search;
        } else if (path.startsWith('/t/')) {
            // 图片请求 - 代理到 image.tmdb.org
            targetUrl = 'https://image.tmdb.org' + path + url.search;
        } else if (path === '/' || path === '') {
            // 根路径 - 返回使用说明
            return new Response(JSON.stringify({
                status: 'ok',
                message: 'TMDB Proxy is running',
                usage: {
                    api: '/api/3/movie/popular?api_key=YOUR_KEY&language=zh-CN',
                    image: '/t/p/w500/YOUR_IMAGE_PATH.jpg'
                }
            }, null, 2), {
                headers: {
                    'Content-Type': 'application/json',
                    ...corsHeaders
                }
            });
        } else {
            // 未知路径
            return new Response('Not Found', { status: 404, headers: corsHeaders });
        }

        try {
            // 检查是否是图片请求，使用不同的缓存策略
            const isImageRequest = path.startsWith('/t/');

            // 构建缓存键（确保相同请求使用相同缓存）
            const cacheKey = new Request(targetUrl, {
                method: 'GET',
                headers: { 'Accept': isImageRequest ? 'image/*' : 'application/json' }
            });

            // 尝试从 Cloudflare Cache 获取
            const cache = caches.default;
            let response = await cache.match(cacheKey);

            if (!response) {
                // 缓存未命中，发起请求
                response = await fetch(targetUrl, {
                    method: request.method,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': request.headers.get('Accept') || '*/*',
                    }
                });

                // 只缓存成功的响应
                if (response.ok) {
                    const responseToCache = response.clone();
                    const cacheHeaders = new Headers(responseToCache.headers);
                    // 图片缓存 7 天，API 缓存 10 分钟
                    cacheHeaders.set('Cache-Control', isImageRequest ? 'public, max-age=604800' : 'public, max-age=600');

                    const cachedResponse = new Response(responseToCache.body, {
                        status: responseToCache.status,
                        headers: cacheHeaders
                    });

                    // 异步存入缓存，不阻塞响应
                    ctx.waitUntil(cache.put(cacheKey, cachedResponse));
                }
            }

            // 克隆响应并添加 CORS 头
            const newHeaders = new Headers(response.headers);
            Object.entries(corsHeaders).forEach(([key, value]) => {
                newHeaders.set(key, value);
            });

            // 对于图片，添加更长的缓存控制
            if (isImageRequest) {
                newHeaders.set('Cache-Control', 'public, max-age=604800'); // 7天
            }

            return new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: newHeaders
            });

        } catch (error) {
            return new Response(JSON.stringify({ error: error.message }), {
                status: 500,
                headers: {
                    'Content-Type': 'application/json',
                    ...corsHeaders
                }
            });
        }
    }
};
