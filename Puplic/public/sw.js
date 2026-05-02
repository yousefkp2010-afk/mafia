const CACHE_NAME = 'mafia-v1.0';
const ASSETS_TO_CACHE = [
    '/',                  // الصفحة الرئيسية (سيخدم index.html)
    '/index.html',
    '/style.css',
    '/main.js',
    '/manifest.json'
];

// حدث التثبيت: تخزين الملفات الأساسية
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('تخزين ملفات اللعبة الرئيسية...');
            return cache.addAll(ASSETS_TO_CACHE);
        })
    );
    // تفعيل السيرفس ووركر فوراً دون انتظار الصفحات المفتوحة القديمة
    self.skipWaiting();
});

// حدث التفعيل: تنظيف الكاشات القديمة
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cache) => {
                    if (cache !== CACHE_NAME) {
                        return caches.delete(cache);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

// استراتيجية: الشبكة أولاً مع الرجوع إلى الكاش عند الفشل (مثالي للإيقاظ)
self.addEventListener('fetch', (event) => {
    // لا نحاول تخزين طلبات Socket.IO (تأتي عبر polling/websocket)
    if (event.request.url.includes('/socket.io/')) {
        return; // نترك المتصفح يتعامل معها مباشرة
    }

    event.respondWith(
        fetch(event.request)
            .then((response) => {
                // تخزين النسخة الجديدة في الكاش إذا كان الطلب ناجحاً
                if (response.ok) {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseClone);
                    });
                }
                return response;
            })
            .catch(() => {
                // فشل الشبكة: استخدم الكاش
                return caches.match(event.request).then((cachedResponse) => {
                    // إذا لم يوجد في الكاش، يمكننا إرجاع الصفحة الرئيسية (للـ SPA)
                    if (event.request.mode === 'navigate') {
                        return caches.match('/index.html');
                    }
                    return cachedResponse;
                });
            })
    );
});