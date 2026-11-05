// 测试环境默认「记忆开着、蒸馏关着」：
// 1) 记忆工具（memory_read/write/delete）与记忆索引是产品默认行为，用例要能断言它们常驻；
// 2) 但回合后的后台蒸馏会吃掉排队的 mock 响应、打乱 streamMock.mock.calls 的序号断言，
//    也会把测试产出写进真实 ~/.meowcode/memory —— 所以单独用 MEOWCODE_MEMORY_DISTILL 关掉。
// 需要专门测蒸馏调度时，在用例内传构造参数 { memory: true, distill: true }。
process.env.MEOWCODE_MEMORY = "1";
process.env.MEOWCODE_MEMORY_DISTILL = "0";
// 自我学习同理：门禁虽严，但「用户纠正/工具密集」的用例会命中信号并发出学习请求，
// 同样会吃掉排队的 mock 响应。要专门测学习调度时在用例内传 learning: true。
process.env.MEOWCODE_SELF_LEARNING = "0";
