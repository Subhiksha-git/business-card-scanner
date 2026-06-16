import { useState, useRef, useCallback, useEffect } from "react";
import Tesseract from "tesseract.js";


// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const OCR_API_KEY = "K86733826488957";
const OCR_URL     = "https://api.ocr.space/parse/image";


// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — FileReader → Image → Canvas pipeline
//
//  Why FileReader instead of URL.createObjectURL?
//  createObjectURL can silently fail inside sandboxed iframes and certain
//  mobile browsers, firing img.onerror with no useful message.
//  FileReader.readAsDataURL() produces a fully self-contained data-URL that
//  works universally — no object-URL lifecycle to manage.
//
//  Resolves with full data-URL: "data:image/jpeg;base64,/9j/4AAQ…"
// ─────────────────────────────────────────────────────────────────────────────
function imageToBase64(file) {
  return new Promise((resolve, reject) => {


    // ── Validate MIME before touching any browser API ──────────────────────
    const ALLOWED = ["image/jpeg", "image/jpg", "image/png"];
    if (!ALLOWED.includes(file.type)) {
      const msg = `Unsupported file type "${file.type}". Please upload a JPG or PNG.`;
      console.error("❌ [imageToBase64]", msg);
      reject(new Error(msg));
      return;
    }


    console.log(`📂 [imageToBase64] Reading file — name:"${file.name}" type:"${file.type}" size:${file.size}b`);


    // ── Stage 1: FileReader converts the raw file into a data-URL ─────────
    const reader = new FileReader();


    reader.onerror = () => {
      const msg = `FileReader failed: ${reader.error?.message || "unknown error"}`;
      console.error("❌ [imageToBase64]", msg, reader.error);
      reject(new Error(msg));
    };


    reader.onload = () => {
      const dataUrl = reader.result;


      if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
        const msg = "FileReader result is not a valid image data-URL.";
        console.error("❌ [imageToBase64]", msg, dataUrl);
        reject(new Error(msg));
        return;
      }


      console.log(`✅ [imageToBase64] FileReader OK — prefix:"${dataUrl.substring(0, 40)}…"`);


      // ── Stage 2: Image() decodes the data-URL ──────────────────────────
      const img = new Image();


      img.onerror = (evt) => {
        const msg = "Image() could not decode the file — it may be corrupt or not a real image.";
        console.error("❌ [imageToBase64] img.onerror:", evt);
        console.error("❌ [imageToBase64]", msg);
        reject(new Error(msg));
      };


      img.onload = () => {
        console.log(`🖼  [imageToBase64] Image decoded — ${img.width}×${img.height}px`);


        // ── Stage 3: Canvas — resize to max 1800px + contrast boost ───────
        const MAX = 1800;
        let { width: w, height: h } = img;
        if (w > MAX || h > MAX) {
          const ratio = Math.min(MAX / w, MAX / h);
          w = Math.round(w * ratio);
          h = Math.round(h * ratio);
          console.log(`🔲 [imageToBase64] Resized to ${w}×${h}px`);
        }


        const canvas = document.createElement("canvas");
        canvas.width  = w;
        canvas.height = h;


        const ctx = canvas.getContext("2d");
        if (!ctx) {
          const msg = "Failed to obtain 2D context from canvas.";
          console.error("❌ [imageToBase64]", msg);
          reject(new Error(msg));
          return;
        }


        ctx.drawImage(img, 0, 0, w, h);


        // Contrast ×1.45 — sharper edges help OCR Engine 2
        const id = ctx.getImageData(0, 0, w, h);
        const px = id.data;
        const f  = 1.45;
        const ic = 128 * (1 - f);
        for (let i = 0; i < px.length; i += 4) {
          px[i]     = Math.min(255, Math.max(0, px[i]     * f + ic));
          px[i + 1] = Math.min(255, Math.max(0, px[i + 1] * f + ic));
          px[i + 2] = Math.min(255, Math.max(0, px[i + 2] * f + ic));
        }
        ctx.putImageData(id, 0, 0);


        const outputDataUrl = canvas.toDataURL("image/jpeg", 0.9);


        if (!outputDataUrl.startsWith("data:image/jpeg;base64,")) {
          const msg = "canvas.toDataURL() did not return a valid JPEG data-URL.";
          console.error("❌ [imageToBase64]", msg);
          reject(new Error(msg));
          return;
        }


        console.log(`✅ [imageToBase64] Canvas export OK — length:${outputDataUrl.length} prefix:"${outputDataUrl.substring(0, 50)}…"`);
        resolve(outputDataUrl); // full data-URL — prefix already included
      };


      img.src = dataUrl; // hand FileReader result to Image()
    };


    reader.readAsDataURL(file); // kick off the read
  });
}

function saveToQueue(item) {
  let queue = JSON.parse(localStorage.getItem("queue") || "[]");


  queue.push({
    id: Date.now(),
    ...item,
    status: "pending",
    synced: false,
    createdAt: new Date().toISOString()
  });


  localStorage.setItem("queue", JSON.stringify(queue));
}


async function tesseractOCR(dataUrl) {


  const worker = await Tesseract.createWorker({
    logger: m => console.log("🧠 OCR Progress:", m),


    workerPath: "./worker.min.js",
    corePath: "./node_modules/tesseract.js-core/",
    langPath: "./tessdata/"
  });


  await worker.load();
  await worker.loadLanguage("eng");
  await worker.initialize("eng");


  const { data: { text } } = await worker.recognize(dataUrl);


  await worker.terminate();


  return (text || "").trim();
}


async function syncQueue() {
  let queue = JSON.parse(localStorage.getItem("queue") || "[]");


  if (queue.length === 0) return;


  console.log("🌐 Internet detected → syncing queue...", queue.length);


  const remaining = [];


  for (let item of queue) {
    try {
      await fetch("/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item)
      });


      console.log("✅ Sent:", item.id);


    } catch (err) {
      console.log("❌ Failed, keeping in queue:", item.id);
      remaining.push(item);
    }
  }


  localStorage.setItem("queue", JSON.stringify(remaining));


  console.log("🎯 Sync complete. Remaining:", remaining.length);
}


// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — OCR.Space API call (application/json)
//
//  WHY JSON instead of application/x-www-form-urlencoded?
//  URL-encoding percent-encodes every +, /, and = in the base64 string,
//  bloating a 200 KB image payload to ~270 KB and causing "Failed to fetch"
//  in sandboxed environments that enforce request-size or encoding limits.
//  JSON.stringify() transmits the base64 string byte-for-byte — no overhead.
// ─────────────────────────────────────────────────────────────────────────────
async function runOCR(file) {
  console.group("🔍 OCR Pipeline");


  const useOfflineOCR = !navigator.onLine;


  if (useOfflineOCR) {
    console.log("📴 Offline mode → using Tesseract OCR");


    const dataUrl = await imageToBase64(file);
    const text = await tesseractOCR(dataUrl);


    saveToQueue({
      image: dataUrl,
      text,
      status: "offline_processed",
      createdAt: new Date().toISOString()
    });


    console.groupEnd();
    return text;
  }


  console.log("🌐 Online mode → OCR.Space API");


  const dataUrl = await imageToBase64(file);


  const payload = {
    apikey: OCR_API_KEY,
    base64Image: dataUrl,
    language: "eng",
    isOverlayRequired: false,
    detectOrientation: true,
    scale: true,
    OCREngine: 2,
  };


  let res;
  try {
    res = await fetch(OCR_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("❌ Network error:", err);
    console.groupEnd();
    throw err;
  }


  const json = await res.json();


  if (json.IsErroredOnProcessing) {
    console.groupEnd();
    throw new Error(json.ErrorMessage);
  }


  const text = (json.ParsedResults?.[0]?.ParsedText || "").trim();


  saveToQueue({
    image: dataUrl,
    text,
    status: "online_processed",
    createdAt: new Date().toISOString()
  });


  console.groupEnd();
  return text;
}


// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — Parse raw OCR text → { name, phone, email, company }
//            Each regex is logged so you can see exactly what matched
// ─────────────────────────────────────────────────────────────────────────────
function parseContact(rawText) {
  console.group("🧩 Contact Parser");
  console.log("🔥 NEW CODE RUNNING");
  console.log("📋 Input text:\n" + rawText);


  // Normalise: collapse multiple spaces, keep newlines
  const text  = rawText.replace(/[ \t]+/g, " ").trim();
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  console.log("📑 Lines:", lines);


  const result = { name: "", phone: "", email: "", company: "" };


  // ── EMAIL ──────────────────────────────────────────────────────────────────
  // Broad match; OCR sometimes replaces @ with (a) or [at]
  const emailRaw = text.match(
    /[a-zA-Z0-9._%+\-]+(?:@|\(a\)|\[at\])[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/i
  );
  if (emailRaw) {
    result.email = emailRaw[0].replace(/\(a\)|\[at\]/i, "@");
    console.log("✉️  Email matched:", result.email);
  } else {
    console.warn("⚠️  No email found");
  }


  // ── PHONE ──────────────────────────────────────────────────────────────────
  // Match international (+91 98765 43210), local (044-2345-6789), plain blocks
  const phonePatterns = [
  /(?:\+?\d{1,3}[\s\-.]?)?\d{5}[\s\-.]?\d{5}/g,
  /\b\d{10}\b/g,
  /\b\d{5}[\s\-]\d{5}\b/g,
  ];
  let bestPhone = null;
  for (const rx of phonePatterns) {
    const hits = [...text.matchAll(rx)].map(m => m[0].trim());
    console.log("PHONE HITS:", hits);
    const hit  = hits.find(p => {
      const d = p.replace(/\D/g, "");
      return d.length >= 7 && d.length <= 15;
    });
    if (hit) { bestPhone = hit; break; }
  }
  if (bestPhone) {
    result.phone = bestPhone;
    console.log("📞 Phone matched:", result.phone);
    console.log("📞 Digits:", result.phone.replace(/\D/g, ""));
    console.log("📞 Length:", result.phone.length);
    console.log("📞 Chars:", [...result.phone]);


  } else {
    console.warn("⚠️  No phone found");
  }


  // ── COMPANY ────────────────────────────────────────────────────────────────
  // Lines with explicit business-type keywords OR ALL-CAPS short names
  const coKeyRx = /\b(pvt\.?\s*ltd\.?|llc|inc\.?|corp\.?|ltd\.?|co\.?\s*ltd\.?|technologies|tech|solutions|systems|software|services|consulting|group|associates|international|enterprises|ventures|holdings|labs|studio|agency|media|global|digital)\b/i;
  const coAllCapsRx = /^[A-Z][A-Z\s&.,]{3,}$/; // e.g. "ACME CORP" or "TCS & INFOSYS"


  for (const line of lines) {
    if (!result.company) {
      if (coKeyRx.test(line)) {
        result.company = line;
        console.log("🏢 Company (keyword):", result.company);
      } else if (coAllCapsRx.test(line) && line.length < 50 && !line.match(/\d{4,}/)) {
        result.company = line;
        console.log("🏢 Company (all-caps):", result.company);
      }
    }
  }
  if (!result.company) console.warn("⚠️  No company found");


  // ── NAME ───────────────────────────────────────────────────────────────────
  // Priority 1: Title-cased 2–4 word line not matching other fields
  const nameTitleRx = /^[A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,3}$/;
  // Priority 2: A line with "Mr.", "Ms.", "Dr.", "Prof." prefix
  const namePrefixRx = /^(?:Mr\.?|Ms\.?|Mrs\.?|Dr\.?|Prof\.?)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/i;


  const skipLine = (l) =>
    l === result.email ||
    l === result.phone ||
    l === result.company ||
    l.includes("@") ||
    coKeyRx.test(l) ||
    /\d{4,}/.test(l) ||          // long digit string = not a name
    /(?:www\.|http|\.com)/i.test(l);


  // Prefix match first
  for (const line of lines) {
    if (!result.name && namePrefixRx.test(line) && !skipLine(line)) {
      result.name = line;
      console.log("👤 Name (prefix):", result.name);
    }
  }
  // Title-case match
  if (!result.name) {
    for (const line of lines) {
      if (!result.name && nameTitleRx.test(line) && !skipLine(line)) {
        result.name = line;
        console.log("👤 Name (title-case):", result.name);
      }
    }
  }
  // Fallback: first short alpha-only line
  if (!result.name) {
    for (const line of lines) {
      if (/^[A-Za-z\s.'-]{3,45}$/.test(line) && !skipLine(line)) {
        result.name = line;
        console.log("👤 Name (fallback):", result.name);
        break;
      }
    }
  }
  if (!result.name) console.warn("⚠️  No name found");


  console.log("📇 Final parsed contact:", result);
  console.groupEnd();
  return result;
}


// ─────────────────────────────────────────────────────────────────────────────
// UI COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────


const card = {
  background:   "var(--color-background-primary)",
  border:       "0.5px solid var(--color-border-tertiary)",
  borderRadius: "var(--border-radius-lg)",
};


function Spinner({ size = 28, color = "var(--color-text-info)" }) {
  return (
    <i className="ti ti-loader-2 bcs-spin"
       style={{ fontSize: size, color, display: "inline-block" }} />
  );
}


function Avatar({ name }) {
  const ini = name
    ? name.split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 2).join("").toUpperCase()
    : "?";
  return (
    <div style={{
      width: 46, height: 46, borderRadius: "50%", flexShrink: 0,
      background: "var(--color-background-info)",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: 15, fontWeight: 700, color: "var(--color-text-info)",
    }}>{ini}</div>
  );
}


function Toast({ message, type }) {
  const icon = { success: "ti-circle-check", warning: "ti-alert-triangle", danger: "ti-alert-circle" }[type] || "ti-info-circle";
  return (
    <div style={{
      padding: "10px 14px", borderRadius: "var(--border-radius-md)", marginBottom: "1rem",
      background: `var(--color-background-${type})`,
      border:     `0.5px solid var(--color-border-${type})`,
      color:      `var(--color-text-${type})`,
      fontSize: 13, display: "flex", alignItems: "flex-start", gap: 8,
    }}>
      <i className={`ti ${icon}`} style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }} />
      <span style={{ lineHeight: 1.5 }}>{message}</span>
    </div>
  );
}


// Raw OCR text debug panel (shown in UI for easy inspection)
// ⚠️  THIS COMPONENT IS NOT USED IN YOUR UI - so it won't appear!
function RawTextPanel({ text, onClose }) {
  return (
    <div style={{
      ...card, padding: "1rem 1.25rem", marginBottom: "1.25rem",
      border: "0.5px solid var(--color-border-warning)",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-warning)", display: "flex", alignItems: "center", gap: 6 }}>
          <i className="ti ti-bug" style={{ fontSize: 14 }} />
          OCR Raw Output (debug panel)
        </span>
        <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", padding: 2, color: "var(--color-text-tertiary)" }}>
          <i className="ti ti-x" style={{ fontSize: 14 }} />
        </button>
      </div>
      <pre style={{
        margin: 0, padding: "10px 12px",
        background: "var(--color-background-secondary)",
        border: "0.5px solid var(--color-border-tertiary)",
        borderRadius: "var(--border-radius-md)",
        fontSize: 11.5, lineHeight: 1.6, whiteSpace: "pre-wrap",
        color: "var(--color-text-primary)", maxHeight: 180, overflowY: "auto",
        fontFamily: "monospace",
      }}>
        {text || "(empty)"}
      </pre>
      <p style={{ fontSize: 11, color: "var(--color-text-tertiary)", margin: "6px 0 0" }}>
        Full response also logged to browser console (F12 → Console tab)
      </p>
    </div>
  );
}


function ContactCard({ contact, onDelete }) {
  const { name, phone, email, company } = contact;
  const waLink   = phone ? `https://wa.me/${phone.replace(/\D/g, "")}` : null;
  const mailHref = email ? `mailto:${email}?subject=Following up&body=Hi ${(name || "").split(" ")[0]},` : null;


  return (
    <div style={{ ...card, padding: "1rem 1.25rem", display: "flex", flexDirection: "column", gap: 12 }}>


      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Avatar name={name} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontWeight: 600, fontSize: 15, margin: 0, color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {name || <span style={{ color: "var(--color-text-tertiary)", fontStyle: "italic" }}>Unknown</span>}
          </p>
          {company && (
            <p style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: "2px 0 0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {company}
            </p>
          )}
        </div>
        <button onClick={onDelete} aria-label="Delete contact"
          style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: "var(--color-text-tertiary)" }}>
          <i className="ti ti-trash" style={{ fontSize: 16 }} />
        </button>
      </div>


      {/* Detail rows */}
      <div style={{ borderTop: "0.5px solid var(--color-border-tertiary)", paddingTop: 10, display: "flex", flexDirection: "column", gap: 7 }}>
        {[
          { icon: "ti-phone", value: phone,   href: null       },
          { icon: "ti-mail",  value: email,   href: mailHref   },
        ].map(({ icon, value, href }) => value && (
          <div key={icon} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <i className={`ti ${icon}`} style={{ fontSize: 14, color: "var(--color-text-tertiary)", flexShrink: 0 }} />
            {href
              ? <a href={href} style={{ color: "var(--color-text-info)", wordBreak: "break-all" }}>{value}</a>
              : <span style={{ color: "var(--color-text-primary)" }}>{value}</span>
            }
          </div>
        ))}
      </div>


      {/* Action buttons */}
      {(waLink || mailHref) && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {waLink && (
            <a href={waLink} target="_blank" rel="noreferrer" style={{
              display: "flex", alignItems: "center", gap: 6, textDecoration: "none",
              padding: "7px 16px", borderRadius: "var(--border-radius-md)",
              background: "#25D366", color: "#fff", fontSize: 13, fontWeight: 500,
            }}>
              <i className="ti ti-brand-whatsapp" style={{ fontSize: 15 }} /> WhatsApp
            </a>
          )}
          {mailHref && (
            <a href={mailHref} style={{
              display: "flex", alignItems: "center", gap: 6, textDecoration: "none",
              padding: "7px 16px", borderRadius: "var(--border-radius-md)",
              background: "var(--color-background-secondary)",
              border: "0.5px solid var(--color-border-secondary)",
              color: "var(--color-text-primary)", fontSize: 13, fontWeight: 500,
            }}>
              <i className="ti ti-mail-forward" style={{ fontSize: 15 }} /> Email
            </a>
          )}
        </div>
      )}
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────────────────
const FIELDS = [
  { key: "name",    label: "Full Name", icon: "ti-user"      },
  { key: "company", label: "Company",   icon: "ti-building" },
  { key: "phone",   label: "Phone",     icon: "ti-phone"    },
  { key: "email",   label: "Email",     icon: "ti-mail"     },
];


export default function App() {
  const [contacts,  setContacts]  = useState([]);
  const [scanning,  setScanning]  = useState(false);
  const [progress,  setProgress]  = useState("");
  const [preview,   setPreview]   = useState(null);
  const [extracted, setExtracted] = useState(null);
  const [toast,     setToast]     = useState(null);
  const [dragging,  setDragging]  = useState(false);
  const inputRef  = useRef();
  const timerRef  = useRef();
  
  useEffect(() => {
    window.addEventListener("online", syncQueue);
    return () => window.removeEventListener("online", syncQueue);
  }, []);


  const showToast = useCallback((message, type = "success", ms = 5000) => {
    clearTimeout(timerRef.current);
    setToast({ message, type });
    if (ms > 0) timerRef.current = setTimeout(() => setToast(null), ms);
  }, []);


  const handleFile = useCallback(async (file) => {
    if (!file) return;


    const ALLOWED = ["image/jpeg", "image/jpg", "image/png"];
    if (!ALLOWED.includes(file.type)) {
      showToast(`Unsupported format "${file.type}". Please upload a JPG or PNG file.`, "danger");
      return;
    }


    // Reset state
    setExtracted(null);
    setPreview(URL.createObjectURL(file));
    setScanning(true);
    setProgress("Pre-processing image…");


    try {
      setProgress("Sending to OCR.Space API…");
      const ocrText = await runOCR(file);     // throws on any failure
      setProgress("Parsing contact fields…");


      const parsed = parseContact(ocrText);
      setExtracted(parsed);


      const found = Object.values(parsed).filter(Boolean).length;
      showToast(
        found > 0
          ? `Extracted ${found} field${found > 1 ? "s" : ""} — review below and save.`
          : "OCR succeeded but no structured fields were found. Check raw output below.",
        found > 0 ? "success" : "warning"
      );


    } catch (err) {
      console.error("💥 OCR pipeline failed:", err);
      showToast(
        `OCR failed — ${err.message}. Open the browser console (F12) for full details.`,
        "danger", 0
      );
    } finally {
      setScanning(false);
      setProgress("");
    }
  }, [showToast]);


  const onDrop = e => {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  };


  const updateField = (key, val) => setExtracted(x => ({ ...x, [key]: val }));


  const saveContact = () => {
    if (!extracted) return;
    setContacts(c => [{ id: Date.now(), ...extracted }, ...c]);
    setExtracted(null);
    setPreview(null);
    showToast("✅ Contact saved!", "success");
  };


  const discard = () => {
    setPreview(null);
    setExtracted(null);
  };


  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "2rem 1rem", fontFamily: "var(--font-sans)" }}>


      <style>{`
        @keyframes bcs-spin   { to { transform: rotate(360deg); } }
        @keyframes bcs-drop   { from { opacity:0; transform:translateY(-7px); } to { opacity:1; transform:none; } }
        .bcs-spin  { animation: bcs-spin  0.85s linear infinite; }
        .bcs-drop  { animation: bcs-drop  0.22s ease both; }
        .bcs-hover-delete:hover { color: var(--color-text-danger) !important; }
      `}</style>


      {/* ── Header ── */}
      <div style={{ marginBottom: "1.75rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <i className="ti ti-id-badge-2" style={{ fontSize: 26, color: "var(--color-text-info)" }} />
          <span style={{ fontSize: 21, fontWeight: 700, color: "var(--color-text-primary)" }}>
            Business Card Scanner
          </span>
        </div>
        <p style={{ fontSize: 14, color: "var(--color-text-secondary)", margin: 0 }}>
          Upload a card — OCR extracts name, company, phone &amp; email automatically
        </p>
      </div>


      {/* ── Toast ── */}
      {toast && <div className="bcs-drop"><Toast message={toast.message} type={toast.type} /></div>}


      {/* ── Drop zone ── */}
      <div
        onClick={() => !scanning && inputRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        role="button" tabIndex={0}
        onKeyDown={e => e.key === "Enter" && !scanning && inputRef.current?.click()}
        aria-label="Upload a business card image"
        style={{
          border:       `1.5px dashed ${dragging ? "var(--color-border-info)" : "var(--color-border-secondary)"}`,
          borderRadius: "var(--border-radius-lg)",
          padding:      "2.25rem 1rem",
          textAlign:    "center",
          cursor:       scanning ? "not-allowed" : "pointer",
          background:   dragging ? "var(--color-background-info)" : "var(--color-background-secondary)",
          transition:   "all 0.15s",
          marginBottom: "1.25rem",
          opacity:      scanning ? 0.6 : 1,
        }}
      >
        <input
          ref={inputRef} type="file"
          accept="image/jpeg,image/png"
          style={{ display: "none" }}
          onChange={e => { handleFile(e.target.files[0]); e.target.value = ""; }}
        />


        {scanning ? (
          <>
            <Spinner size={34} />
            <p style={{ fontSize: 15, fontWeight: 600, color: "var(--color-text-primary)", margin: "10px 0 3px" }}>
              {progress}
            </p>
            <p style={{ fontSize: 12, color: "var(--color-text-tertiary)", margin: 0 }}>
              Please wait — do not close this tab
            </p>
          </>
        ) : (
          <>
            <i className="ti ti-cloud-upload" style={{ fontSize: 34, color: "var(--color-text-secondary)", display: "block", marginBottom: 10 }} />
            <p style={{ fontSize: 15, fontWeight: 500, color: "var(--color-text-primary)", margin: "0 0 4px" }}>
              {dragging ? "Drop the card here" : "Click or drag & drop a business card"}
            </p>
            <p style={{ fontSize: 12, color: "var(--color-text-tertiary)", margin: 0 }}>
              JPG · PNG — max 1800px (auto-resized)
            </p>
          </>
        )}
      </div>


      {/* ── Image preview ── */}
      {preview && (
        <div className="bcs-drop" style={{ ...card, overflow: "hidden", marginBottom: "1.25rem" }}>
          <div style={{ position: "relative" }}>
            <img
              src={preview} alt="Business card preview"
              style={{ width: "100%", maxHeight: 220, objectFit: "contain", display: "block", background: "var(--color-background-tertiary)" }}
            />
            {scanning && (
              <div style={{
                position: "absolute", inset: 0,
                background: "rgba(0,0,0,0.42)",
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8,
              }}>
                <Spinner size={30} color="#fff" />
                <span style={{ color: "#fff", fontSize: 13, fontWeight: 500 }}>{progress}</span>
              </div>
            )}
          </div>
        </div>
      )}


      {/* ── Editable extracted fields ── */}
      {extracted && !scanning && (
        <div className="bcs-drop" style={{ ...card, padding: "1rem 1.25rem", marginBottom: "1.25rem" }}>
          <p style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-tertiary)", margin: "0 0 12px", textTransform: "uppercase", letterSpacing: "0.07em" }}>
            Extracted fields — correct if needed, then save
          </p>


          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8, marginBottom: 14 }}>
            {FIELDS.map(({ key, label, icon }) => (
              <div key={key} style={{ background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)", padding: "9px 11px" }}>
                <label style={{ fontSize: 11, color: "var(--color-text-tertiary)", display: "flex", alignItems: "center", gap: 5, marginBottom: 5, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  <i className={`ti ${icon}`} style={{ fontSize: 12 }} />
                  {label}
                </label>
                <input
                  value={extracted[key]}
                  onChange={e => updateField(key, e.target.value)}
                  placeholder={`Enter ${label.toLowerCase()}`}
                  style={{ width: "100%", boxSizing: "border-box", fontSize: 13 }}
                />
              </div>
            ))}
          </div>


          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              onClick={saveContact}
              style={{
                flex: 1, minWidth: 140,
                display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
                background: "var(--color-background-success)",
                color: "var(--color-text-success)",
                borderColor: "var(--color-border-success)",
                fontWeight: 600, fontSize: 14,
              }}
            >
              <i className="ti ti-user-plus" style={{ fontSize: 15 }} />
              Save Contact
            </button>
            <button onClick={discard} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <i className="ti ti-x" style={{ fontSize: 15 }} /> Discard
            </button>
          </div>
        </div>
      )}


      {/* ── Saved contacts list ── */}
      {contacts.length > 0 && (
        <div className="bcs-drop">
          <p style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-tertiary)", margin: "0 0 10px", textTransform: "uppercase", letterSpacing: "0.07em" }}>
            {contacts.length} Saved Contact{contacts.length !== 1 ? "s" : ""}
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {contacts.map(c => (
              <ContactCard key={c.id} contact={c}
                onDelete={() => setContacts(cs => cs.filter(x => x.id !== c.id))} />
            ))}
          </div>
        </div>
      )}


      {/* ── Empty state ── */}
      {contacts.length === 0 && !preview && !scanning && (
        <div style={{ textAlign: "center", padding: "2.5rem 0", color: "var(--color-text-tertiary)" }}>
          <i className="ti ti-address-book" style={{ fontSize: 42, display: "block", marginBottom: 10 }} />
          <p style={{ fontSize: 13, margin: 0 }}>No contacts yet — scan your first business card above.</p>
        </div>
      )}
    </div>
  );
}
