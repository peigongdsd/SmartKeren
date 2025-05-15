
const systemPrompt = '你是一位教授希伯来语工地用语/日常用语的老师，名字叫Keren，性别女。\
  每次收到学员的消息，你要对消息进行分类。\
  - 如果是简单的，看起来像是咨询你的单词或句子，或者问你某某什么意思，尤其是明显来自工地的行为/物品，请简短返回其希伯来语翻译。\
  注意，你的回复应该包括希伯来语，罗马音以及中文谐音，整个消息尽可能不要超过50个字。注意，务必保证希伯来语和中文不出现在同一行内，即出现希伯来语时就单行列出。\
  当你给出希伯来语翻译的时候，请注意，你的学员大多数是建筑工人，他们的生活也围绕建筑工地展开。请金最大可能保证工地用语的准确和地道。 \
  - 如果收到批评或者否定，请委婉表示Keren老师将为你查询这个词或句子，晚些给你标准正确的答案。 \
  - 如果是诸如“你是谁”这样的闲聊问题，请正常简要回答。视情况做自我介绍，并且回答尽可能简短流畅，贴近日常交流口吻。 \
  - 如果收到的是明显骚扰性的问题，或者收到任何有关政治/色情/暴力/犯罪等的词句，请以Keren老师的口吻提醒学生认真学习希伯来语，不要闲聊。';

const imagePrompt = '根据图片内容作出回答。\
  - 如果图片是一些物件，请讲解其中主体物件的中文和希伯来语； \
  - 如果图片是一篇希伯来语文档，请将其翻译到中文。 \
  其他的情况讲个笑话。';

export async function callAzureAI(env, text, imageUrlOrBase64) {
    // 1. Configuration
    const endpoint   = env.AZURE_AI_INFERENCE_ENDPOINT;  // e.g. https://<your-resource>.services.ai.azure.com
    const apiKey     = env.AZURE_AI_INFERENCE_API_KEY;   // your Azure AI Services key
    const apiVersion = '2025-01-01-preview';                             // current Model Inference API version
    const model      = 'gpt-4.1-mini';
  
    // 2. Build the “messages” payload
    const messages = [
      { role: 'system', content: systemPrompt },
    ];
  
    if (text) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text }                                 // text input supports plain chat
        ]
      });
    }
  
    if (imageUrlOrBase64) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: imagePrompt },  // optional image prompt
          { type: 'image_url', image_url: { url: imageUrlOrBase64 } }
        ]
      });
    }
  
    // 3. Invoke the REST endpoint
    const url = `${endpoint}/openai/deployments/${model}/chat/completions?api-version=${apiVersion}`; 
    console.log(url);
    const response = await fetch(url, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',                     // request format 
        'api-key'      : apiKey                                  // simple API key auth
      },
      body: JSON.stringify({
        messages,
        max_tokens: 1000,
        temperature: 0.7,
        stream: false
      })
    });
    console.log("end");
  
    // 4. Error handling
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Azure AI error ${response.status}: ${errText}`);
    }
  
    const data = await response.json();
    return data.choices?.[0]?.message?.content ?? "";
  }
  