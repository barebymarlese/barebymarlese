BARE by Marlese — HTML site (upload to GoDaddy)

FILES
- index.html
- /assets/ (images used by the page)

HOW TO UPLOAD TO GODADDY (QUICK)
1) Make sure your GoDaddy product is “Web Hosting” (cPanel) or similar hosting that supports file uploads.
   - If you’re using “Websites + Marketing” (the GoDaddy website builder), it does NOT let you upload a custom HTML site.
2) Open GoDaddy → My Products → Web Hosting → Manage.
3) Choose one method:
   A) cPanel → File Manager → open “public_html” → Upload index.html + the assets folder
   B) FTP (FileZilla):
      - Host: your server name (from GoDaddy hosting panel)
      - Username/Password: your hosting (cPanel) credentials
      - Upload index.html + assets/ into public_html
4) Visit your domain. If you already had a site, clear cache / wait a minute, then refresh.

IF YOUR SITE DOESN’T SHOW
- Confirm files are in /public_html (not inside another folder).
- Confirm you uploaded the entire assets folder (and its contents).
- Confirm the homepage file name is exactly: index.html

EDITING TEXT / COLOURS
- Open index.html in any text editor.
- Colours are at the top in :root (CSS variables).

