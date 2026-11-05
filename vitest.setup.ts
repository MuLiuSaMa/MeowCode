// 测试环境默认关掉回合后记忆蒸馏（MEOWCODE_MEMORY_EXTRACTION，server/env 同款开关）：
// 1) runtime 集成测试的 mock provider 不预期蒸馏的额外请求 —— 它会吃掉排队的
//    mock 响应、打乱 streamMock.mock.calls 的调用序号断言；
// 2) 防止测试回合的蒸馏把产出写进真实 ~/.meowcode/memory。
// 需要专门测蒸馏调度时，在用例内自行覆盖该变量或用构造参数 memoryExtraction 打开。
process.env.MEOWCODE_MEMORY_EXTRACTION = "0";
// 自我学习同理：门禁虽严，但「用户纠正/工具密集」的用例会命中信号并发出学习请求，
// 同样会吃掉排队的 mock 响应。要专门测学习调度时在用例内传 learning: true。
process.env.MEOWCODE_SELF_LEARNING = "0";
