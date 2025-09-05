
Favicons pack

Place these files in your site's root (or /public for Vite/React). Then add to <head>:

  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="manifest" href="/site.webmanifest">
  <meta name="msapplication-TileColor" content="#ffffff">
  <meta name="msapplication-TileImage" content="/mstile-150x150.png">
  <meta name="theme-color" content="#ffffff">

For Vite:
  - Put files in: public/
  - Use the same <head> tags in index.html (paths start with /)
