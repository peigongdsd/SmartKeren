export async function callAzureAI(env, text, imageUrlOrBase64) {
    // 1. Configuration
    const endpoint   = env.AZURE_AI_INFERENCE_ENDPOINT;  // e.g. https://<your-resource>.services.ai.azure.com :contentReference[oaicite:0]{index=0}
    const apiKey     = env.AZURE_AI_INFERENCE_API_KEY;   // your Azure AI Services key :contentReference[oaicite:1]{index=1}
    const apiVersion = '2025-01-01-preview';                             // current Model Inference API version :contentReference[oaicite:2]{index=2}
    const model      = 'gpt-4.1-mini';
  
    // 2. Build the “messages” payload
    const messages = [
      { role: 'system', content: systemprompt },
    ];
  
    if (text) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text }                                 // text input supports plain chat :contentReference[oaicite:3]{index=3}
        ]
      });
    }
  
    if (imageUrlOrBase64) {
      messages.push({
        role: 'user',
        content: ([
          { type: 'text', text: 'Please analyze this image.' },  // optional image prompt :contentReference[oaicite:4]{index=4}
          { type: 'image_url', image_url: { url: imageUrlOrBase64 } }
        ]).toString()
      });
    }
  
    // 3. Invoke the REST endpoint
    const url = `${endpoint}/openai/deployments/${model}/chat/completions?api-version=${apiVersion}`; //:contentReference[oaicite:5]{index=5}
    const response = await fetch(url, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',                     // request format :contentReference[oaicite:6]{index=6}
        'api-key'      : apiKey                                  // simple API key auth :contentReference[oaicite:7]{index=7}
      },
      body: JSON.stringify({
        messages,
        max_tokens: 1000,
        stream: false
      })
    });
  
    // 4. Error handling
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Azure AI error ${response.status}: ${errText}`);
    }
  
    const data = await response.json();
    return data.choices?.[0]?.message?.content ?? "";
  }
  