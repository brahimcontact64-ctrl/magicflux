import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface NotifyPayload {
  requestId: string;
  templateName: string;
  requestType: string;
  contactEmail: string;
  description: string;
}

async function sendResendEmail(to: string, subject: string, html: string): Promise<void> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) return;

  const fromEmail = Deno.env.get("OWNER_EMAIL") || "noreply@magicflux.ai";

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: fromEmail, to, subject, html }),
  });
}

async function sendTelegramMessage(text: string): Promise<void> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  if (!token || !chatId) return;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const payload: NotifyPayload = await req.json();
    const { requestId, templateName, requestType, contactEmail, description } = payload;

    const ownerEmail = Deno.env.get("OWNER_EMAIL");

    const ownerHtml = `
      <h2>New Managed Request</h2>
      <p><strong>Template:</strong> ${templateName}</p>
      <p><strong>Service:</strong> ${requestType}</p>
      <p><strong>Customer email:</strong> ${contactEmail}</p>
      <p><strong>Description:</strong> ${description}</p>
      <p><strong>Request ID:</strong> ${requestId}</p>
      <p><a href="${Deno.env.get("NEXT_PUBLIC_SITE_URL") || "https://magicflux.ai"}/admin">View in Admin Dashboard</a></p>
    `;

    const customerHtml = `
      <h2>We received your request!</h2>
      <p>Thanks for requesting the <strong>${templateName}</strong> automation.</p>
      <p>Our team will review your request and reach out within 24 hours to confirm scope and get started.</p>
      <p><strong>Service selected:</strong> ${requestType}</p>
      <hr />
      <p style="color:#888;font-size:12px;">MagicFlux · No payment required upfront. We confirm scope first.</p>
    `;

    const telegramText = `<b>New Managed Request</b>\n\nTemplate: ${templateName}\nService: ${requestType}\nCustomer: ${contactEmail}\n\n${description}`;

    const tasks: Promise<void>[] = [
      sendTelegramMessage(telegramText),
      sendResendEmail(contactEmail, `Your ${templateName} automation request — we're on it!`, customerHtml),
    ];

    if (ownerEmail) {
      tasks.push(sendResendEmail(ownerEmail, `New managed request: ${templateName} (${requestType})`, ownerHtml));
    }

    await Promise.allSettled(tasks);

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
