/** 未发送队列的状态流转（纯函数，便于单测）。 */
function nextAction(item) {
  if (!item || item.status === "sent") return null;
  return item.smtpOk ? "append" : "send";
}

function markSending(item) {
  return {
    status: "sending",
    attempts: (Number(item?.attempts) || 0) + 1,
    lastError: null,
  };
}

function markSmtpOk() {
  return { status: "sending", smtpOk: true, lastError: null };
}

function markSmtpFailed(detail) {
  return { status: "failed", smtpOk: false, lastError: detail || "smtp_error" };
}

function markSent() {
  return { status: "sent", lastError: null };
}

function markAppendFailed(detail) {
  return { status: "failed", smtpOk: true, lastError: detail || "append_failed" };
}

function resetInterrupted(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item.status === "sending")
    .map((item) => ({
      id: item.id,
      // SMTP 已接受（smtpOk）只需补 APPEND，可自动续跑；否则崩溃窗口内可能已投递，
      // 改为 failed 由用户手动重试，避免重启自动重发造成重复投递
      patch: item.smtpOk
        ? { status: "queued" }
        : { status: "failed", smtpOk: false, lastError: "interrupted" },
    }));
}

module.exports = {
  nextAction,
  markSending,
  markSmtpOk,
  markSmtpFailed,
  markSent,
  markAppendFailed,
  resetInterrupted,
};
