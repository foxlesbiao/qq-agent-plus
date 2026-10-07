// 「平台能力」设置分区（2026-10-07）：协议端 SnowLuma ≥1.14.20 接入的 QQ 平台能力开关。
// 口径与表情包/搜索/ASR 一致：开关关掉后，对应工具会被 orchestrator 从模型工具表里摘除、
// 提示词也不再教用法 —— 不只是"界面上隐藏"。个别项来自 send.*（正在输入），其余一对一映射
// config.platform.*；保存映射见 settings-save.js。
'use strict';


/** 「平台能力」分区：复选框 id 与 settings-save.js 里的 chk('#cfg-platform-*') 一一对应。 */
function renderPlatformSection(c) {
  const p = c.platform || {};
  return `
    <h3>像群友一样的小动作</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-typing" ${c.send?.typingIndicator !== false ? 'checked' : ''} />
      <label for="cfg-typing">私聊发言前先亮「正在输入…」（群聊 QQ 没有输入状态，只对私聊生效）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-platform-reactions" ${p.reactions !== false ? 'checked' : ''} />
      <label for="cfg-platform-reactions">表情回应：给群里的消息贴表情（收、发都归它；关掉后不贴也看不到谁贴了）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-platform-qqvoice" ${p.qqVoice !== false ? 'checked' : ''} />
      <label for="cfg-platform-qqvoice">QQ 原生语音：用 QQ 内置的语音角色发语音（群聊限定）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-platform-profile" ${p.profileWrites !== false ? 'checked' : ''} />
      <label for="cfg-platform-profile">允许改自己的资料：个性签名 / 在线状态 / 给好友或群设备注（每天有次数上限）</label></div>

    <h3>信息与素材</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-platform-grouptools" ${p.groupTools !== false ? 'checked' : ''} />
      <label for="cfg-platform-grouptools">群资料：看群简介/公告/荣誉、每日群签到、把消息设成群待办</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-platform-ocr" ${p.ocr !== false ? 'checked' : ''} />
      <label for="cfg-platform-ocr">服务端 OCR：读图上的文字（视觉模型关掉时也能用）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-platform-groupfiles" ${p.groupFiles !== false ? 'checked' : ''} />
      <label for="cfg-platform-groupfiles">群文件：查看目录、取某个文件的下载直链、发文件到群</label></div>

    <h3>群相册</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-platform-albumread" ${p.albumRead !== false ? 'checked' : ''} />
      <label for="cfg-platform-albumread">看相册、给照片点赞 / 评论</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-platform-albumupload" ${p.albumUpload === true ? 'checked' : ''} />
      <label for="cfg-platform-albumupload">把图传进群相册（<b>所有人都看得到</b>，默认关）</label></div>

    <h3>会话与呈现</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-platform-readreceipts" ${p.readReceipts === true ? 'checked' : ''} />
      <label for="cfg-platform-readreceipts">处理完的消息在 QQ 里标已读（默认关：开了之后你自己各端看不到未读小红点）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-platform-forwardcards" ${p.forwardCards !== false ? 'checked' : ''} />
      <label for="cfg-platform-forwardcards">群日报等长内容用「聊天记录卡片」发送（关掉＝回到一整段文本）</label></div>

    <div class="hint">
      这些能力来自协议端 SnowLuma 1.14.20+（线上已升到 1.14.22）。关掉的项不只是"不显示"：
      对应工具会从模型的工具表里摘除，模型不会再调用它们，也不会在提示词里看到用法。
    </div>`;
}

export { renderPlatformSection };
