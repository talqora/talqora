ObjC.import('Cocoa');
ObjC.import('CoreGraphics');

function run(argv) {
  var x = Number(argv[0]);
  var y = Number(argv[1]);
  var kind = argv[2] || 'left';
  var pt = $.CGPointMake(x, y);
  var src = $.CGEventSourceCreate($.kCGEventSourceStateHIDSystemState);
  var down = kind === 'right' ? $.kCGEventRightMouseDown : $.kCGEventLeftMouseDown;
  var up = kind === 'right' ? $.kCGEventRightMouseUp : $.kCGEventLeftMouseUp;
  var btn = kind === 'right' ? $.kCGMouseButtonRight : $.kCGMouseButtonLeft;
  $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(src, $.kCGEventMouseMoved, pt, btn));
  delay(0.1);
  $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(src, down, pt, btn));
  delay(0.1);
  $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(src, up, pt, btn));
  delay(0.4);
  return 'clicked ' + x + ',' + y + ' ' + kind;
}
