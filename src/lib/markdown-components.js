import React from "react";

export const markdownComponents = {
  a: ({ href, children }) => href
    ? React.createElement("a", { href }, children)
    : React.createElement("span", null, children),
  img: ({ alt }) => React.createElement("span", { className: "markdown-image-placeholder" }, `[图片：${alt || "无替代文本"}]`),
};
