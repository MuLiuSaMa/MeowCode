import { describe, expect, it } from "vitest";
import { normalizeAskQuestions } from "./ask-questions.js";

describe("normalizeAskQuestions", () => {
  it("字符串选项原样保留", () => {
    expect(
      normalizeAskQuestions({
        questions: [{ question: "用哪种风格？", options: ["简洁", "活泼"] }],
      }),
    ).toEqual([{ question: "用哪种风格？", options: ["简洁", "活泼"] }]);
  });

  it("选项写成 {label, description} 时拍平成文本 + 等长描述", () => {
    // 真实事故：模型这么传，旧实现 String(option) 后选项与答案都是 [object Object]
    expect(
      normalizeAskQuestions({
        questions: [
          {
            question: "剩下的 149 个 error 要处理到什么程度？",
            options: [
              { label: "只修工具链，到此为止", description: "历史 error 只留报告" },
              { label: "顺手修掉自动能修的", description: "约 33 处" },
              { text: "全部修干净" },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        question: "剩下的 149 个 error 要处理到什么程度？",
        options: ["只修工具链，到此为止", "顺手修掉自动能修的", "全部修干净"],
        descriptions: ["历史 error 只留报告", "约 33 处", ""],
      },
    ]);
  });

  it("取不到文本的选项整条丢掉，不产出 [object Object]", () => {
    const [question] = normalizeAskQuestions({
      questions: [{ question: "选哪个？", options: [{ description: "只有说明" }, "可用项", null, 7] }],
    });
    expect(question.options).toEqual(["可用项", "7"]);
    expect(question.options.join()).not.toContain("object");
  });

  it("兼容旧的单题写法 {question, options}", () => {
    expect(normalizeAskQuestions({ question: "继续？", options: ["是", "否"] })).toEqual([
      { question: "继续？", options: ["是", "否"] },
    ]);
  });

  it("缺题目文本的项被丢弃；空参数得到空数组", () => {
    expect(normalizeAskQuestions({ questions: [{ options: ["a"] }] })).toEqual([]);
    expect(normalizeAskQuestions({})).toEqual([]);
  });

  it("题数与选项数都截到 4", () => {
    const questions = normalizeAskQuestions({
      questions: Array.from({ length: 6 }, (_, index) => ({
        question: `q${index}`,
        options: ["a", "b", "c", "d", "e"],
      })),
    });
    expect(questions).toHaveLength(4);
    expect(questions[0].options).toHaveLength(4);
  });
});
