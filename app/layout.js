import './globals.css';

export const metadata = {
  title: 'Lumos',
  description: 'Learning, illuminated.',
  manifest: '/manifest.json',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/icon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Lumos' },
  themeColor: '#0B1436',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <div id="splash-screen" aria-hidden="true">
          <img src="/icon-192.png" alt="" width="120" height="120" />
        </div>
        {children}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              window.addEventListener('load', function () {
                var s = document.getElementById('splash-screen');
                if (s) {
                  s.style.opacity = '0';
                  setTimeout(function () { s.style.display = 'none'; }, 400);
                }
              });
            `,
          }}
        />
      </body>
    </html>
  );
}
