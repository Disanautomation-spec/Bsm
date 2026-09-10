/* ============================================================
   BSM V5 SERVICE WORKER
   ============================================================ */

const CACHE_NAME =
  "bsm-shell-v5";

const SHELL_FILES = [

  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json"

];


/* ============================================================
   INSTALL
   ============================================================ */

self.addEventListener(
  "install",
  event => {

    event.waitUntil(

      caches
        .open(
          CACHE_NAME
        )
        .then(
          cache =>
            cache.addAll(
              SHELL_FILES
            )
        )

    );

    self.skipWaiting();

  }
);


/* ============================================================
   ACTIVATE
   ============================================================ */

self.addEventListener(
  "activate",
  event => {

    event.waitUntil(

      caches
        .keys()
        .then(
          names =>

            Promise.all(

              names

                .filter(
                  name =>
                    name !==
                    CACHE_NAME
                )

                .map(
                  name =>
                    caches.delete(
                      name
                    )
                )

            )
        )

    );

    self.clients.claim();

  }
);


/* ============================================================
   FETCH
   ============================================================ */

self.addEventListener(
  "fetch",
  event => {

    const request =
      event.request;


    /*
     * Only cache GET requests.
     */

    if(
      request.method !==
      "GET"
    )
      return;


    const url =
      new URL(
        request.url
      );


    /*
     * Never intercept external requests.
     *
     * This is particularly important for Binance,
     * backend gateways and WebSockets.
     */

    if(
      url.origin !==
      self.location.origin
    ){

      return;

    }


    /*
     * App-shell strategy:
     *
     * cache first for speed,
     * network fallback for availability.
     */

    event.respondWith(

      caches
        .match(
          request
        )
        .then(
          cached => {

            if(cached)
              return cached;


            return fetch(
              request
            )
            .then(
              response => {

                /*
                 * Cache successful same-origin
                 * responses.
                 */

                if(
                  response &&
                  response.ok
                ){

                  const clone =
                    response.clone();


                  caches
                    .open(
                      CACHE_NAME
                    )
                    .then(
                      cache =>
                        cache.put(
                          request,
                          clone
                        )
                    );

                }


                return response;

              }
            );

          }
        )

    );

  }
);
