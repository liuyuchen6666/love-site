// 修改这个文件即可定制你们的小站，其他文件一般不用动
window.LOVE_CONFIG = {
  siteTitle: "Luis and Nicole's Home 🏠",
  // 在一起的日期（年-月-日 时:分:秒）
  startDate: "2023-05-20 13:14:00",
  // 第一次认识的日期
  metDate: "2026-05-17",

  boy: {
    name: "阿南",
    avatar: "images/boy.svg",
  },
  girl: {
    name: "小北",
    avatar: "images/girl.svg",
  },

  // 顶部背景图，可换成你们的合照
  background: "images/bg.svg",

  // 首页一句话
  slogan: "一辈子很短，要爱对的人",

  // 下面四项是写死在文件里的固定内容，网页上无法修改；
  // 平时直接在网页「编辑」模式里添加即可，这里保持为空
  // 格式示例：moments: [{ date: "2023-05-20", text: "...", image: "图片地址" }]
  moments: [],
  // loveList: [{ title: "一起看日出", done: true }]
  loveList: [],
  // album: [{ src: "图片地址", caption: "描述" }]
  album: [],
  // plans: [{ title: "一起去看极光", date: "2027-12-01", note: "备注" }]
  plans: [],

  // 是否显示右下角的「编辑」按钮（上传照片、写记录、加计划）
  editable: true,

  // 云端保存（Supabase）。留空 = 数据只存在当前浏览器；
  // 填上后手机、电脑看到的是同一份数据，编辑需要登录
  supabase: {
    url: "https://ohglnjtybkbpwnipjaod.supabase.co",
    anonKey: "sb_publishable_Z0dobFYL20zh_3K-6oG1bQ_V2V0-vN2",
  },

  // 高德地图「Web服务」Key（可选，免费）：填了之后地点搜索更准，中文小地点（店、小区、景点）也能搜到
  // 申请：lbs.amap.com → 控制台 → 应用管理 → 创建应用 → 添加 Key（服务平台选“Web服务”）
  amapKey: "",

  footer: "Love is patient, love is kind",
};
