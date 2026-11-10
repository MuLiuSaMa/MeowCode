/**
 * 自绘标题栏「拖动 = 移动窗口」的位置计算。
 *
 * 单独成模块是为了能测：这里唯一的硬约束是**拖动绝不能改窗口尺寸**。
 * 历史 bug：只调 BrowserWindow.setPosition()，Electron 每帧读当前尺寸再写回，
 * 在 125%/150% 缩放的显示器上 DIP↔像素往返取整会每帧多出 1px，
 * 拖两秒窗口就肉眼可见地胖一圈。所以这里显式把起拖时的宽高钉死。
 */

/**
 * @param {{x:number,y:number,width:number,height:number}} bounds 起拖时的窗口矩形（快照）
 * @param {{x:number,y:number}} startCursor 起拖时的光标位置（屏幕坐标）
 * @param {{x:number,y:number}} cursor 当前光标位置（屏幕坐标）
 * @returns {{x:number,y:number,width:number,height:number}}
 */
function dragBounds(bounds, startCursor, cursor) {
  return {
    x: bounds.x + (cursor.x - startCursor.x),
    y: bounds.y + (cursor.y - startCursor.y),
    // 宽高必须是快照值：不传就会退化成"读当前尺寸再写回"
    width: bounds.width,
    height: bounds.height,
  };
}

module.exports = { dragBounds };
