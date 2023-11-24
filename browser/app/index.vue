<template>
	<div>
		<header>
			<datalist id="workid-list">
				<option v-for="id of workIdList" :key="id" :value="id" />
			</datalist>
			&#x1f4d5; <input class="work-id" type="text" v-model.lazy="workId" list="workid-list" placeholder="Work ID" />
		</header>
		<main>
			<div v-if="workInfo">
				<h2>
					<em class="author">{{workInfo.author}}</em>
					<strong class="title">{{workInfo.title}}</strong>
					<a :href="workInfo.url" target="_blank">&#x1f517;</a>
				</h2>
				<ul class="file-list">
					<li v-for="file of workInfo.files" :key="file.id">
						<h3 class="file-id"><em>{{file.id}}</em></h3>
						<p>
							<i>{{iconForFile(file)}}</i>
							<a :href="'/imslp/' + file.path" target="_blank">{{file.path.split("/").pop()}}</a>
						</p>
					</li>
				</ul>
			</div>
		</main>
	</div>
</template>

<style scoped>
	header
	{
		font-size: 180%;
	}

	header input
	{
		font-size: 150%;
	}

	h2 a
	{
		text-decoration: none;
	}

	.author
	{
		display: inline-block;
		margin: 0 1.2em;
		font-weight: normal;
	}

	li h3
	{
		margin: 0;
		display: inline-block;
	}

	.file-list li
	{
		margin: 0 0 2em;
	}

	.file-list li i
	{
		display: inline-block;
		margin: 0 .5em;
		font-style: normal;
	}

	.file-id::before
	{
		content: "#";
		font-weight: normal;
		color: #aaa;
	}
</style>

<script setup>
	import { ref, reactive, onMounted, watch } from "vue";


	const workIdList = ref([]);
	const workId = ref("");

	const workInfo = ref(null);


	onMounted(async () => {
		const response = await fetch("/workid-list");
		workIdList.value = await response.json();
		//console.log("workIds:", workIdList.value);
	});


	const iconForFile = file => {
		switch (file.ext) {
		case "pdf":
			return String.fromCodePoint(0x1f3bc);

		case "mp3":
		case "ogg":
		case "flac":
			return String.fromCodePoint(0x1f3b5);

		case "mid":
			return String.fromCodePoint(0x1f3b9);
		}

		return "";
	};


	watch(workId, async value => {
		//console.log("workId:", value);
		const response = await fetch(`/work-basic?id=${value}`);
		workInfo.value = await response.json();
	});
</script>
