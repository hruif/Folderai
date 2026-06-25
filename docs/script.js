const languageMenus = Array.from(document.querySelectorAll(".language-menu"));

document.addEventListener("pointerdown", (event) => {
  for (const menu of languageMenus) {
    if (event.target instanceof Node && menu.contains(event.target)) {
      continue;
    }
    menu.removeAttribute("open");
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") {
    return;
  }
  for (const menu of languageMenus) {
    menu.removeAttribute("open");
  }
});
