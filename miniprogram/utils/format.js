const labels = {
  DRAFT: '草稿',
  ACTIVE: '待客户反馈',
  CHANGE_REQUESTED: '申请修改',
  ACCEPTED: '已接受',
  EXPIRED: '已过期',
  WITHDRAWN: '已撤回',
  SUPERSEDED: '已被替代',
};

function money(value) {
  return value === null || value === undefined ? '—' : `￥${value}`;
}

function stateLabel(value) {
  return labels[value] || value;
}

function datePlus(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

module.exports = { labels, money, stateLabel, datePlus };
