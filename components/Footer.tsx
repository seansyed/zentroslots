export default function Footer() {
  return (
    <footer className="border-t bg-white py-10 text-center text-xs text-slate-500">
      © {new Date().getFullYear()} ZentroMeet · Built with Next.js
    </footer>
  );
}
