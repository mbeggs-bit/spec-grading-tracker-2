import './globals.css';
export const metadata = { title: 'Lumos', description: 'Learning, illuminated.' };
export default function RootLayout({ children }) {
  return (<html lang="en"><body>{children}</body></html>);
}
